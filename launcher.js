import chokidar from 'chokidar';
import fs from 'fs';
import rpc from 'discord-rpc';
import axios from "axios";
import https from 'https';
import WebSocket from 'ws';
import Tray from 'windows-trayicon';
import {endpoints, clientId, lockfilePath} from "./constants.js";

if(process.platform !== 'win32') {
  //Sanity. Why would anyone ever run this on other platforms? VALORANT only runs on Windows!
  process.exit(69420);
}
let tray;
if(!tray) {
  tray = new Tray({
    title: 'VALORANT Discord Rich Presence',
    icon: './green.ico',
    menu: [
      {
        id: 'exit',
        caption: 'Exit'
      }
    ]
  });
}

tray.item(() => {
  tray.exit();
  shutdown();
});

const client = new rpc.Client({transport: 'ipc'});
const httpClient = axios.create({httpsAgent: new https.Agent({rejectUnauthorized: false}), proxy: false});

let rpcReady = false;
let riotClientLaunched = false;
let ws = null;
let lockfileCache = null;

if(fs.existsSync(lockfilePath)) {
  riotClientLaunched = true;
}

chokidar.watch(lockfilePath).on('all', async (event, path) => {
  switch(event) {
    case "add":
      riotClientLaunched = true;
      updatePresence();
      break;
    case "unlink":
      riotClientLaunched = false;
      lockfileCache = null;
      //Stop updating presence
      if(rpcReady) {
        client.clearActivity();
      }
      break;
  }
});

client.on('ready', () => {
  rpcReady = true;
  updatePresence();
});

const updatePresence = async () => {
  if(rpcReady && riotClientLaunched) {
    if(!(await isGameLaunched())) {
      return;
    }
    if(!ws) {
      //Connect to Riot Client websocket to listen for events
      let lockfileInfo = getLockfileInfo();
      ws = new WebSocket(`wss://riot:${lockfileInfo.key}@127.0.0.1:${lockfileInfo.port}`, null, {rejectUnauthorized: false});
      ws.on('ready', () => {
        ws.send('[5, "OnJsonApiEvent_chat_v4_presences"]');
      });
      ws.on('message', (data) => {
        updatePresence();
      });
      ws.on('close', () => {
        ws = null;
      });
    }
    let presence = await fetchGameInfo();
    if(presence.notValorant || presence.state === 'closed') {
      return;
    }
    if(presence.state === 'away') {
      //Display away status
      client.setActivity({
        state: 'Away',
        largeImageKey: 'valorant_logo',
        largeImageText: 'VALORANT - Away',
        instance: false
      });
    }
    //If player is in game
    else if(presence.sessionLoopState.toLowerCase() === 'ingame') {
      let map = convertMapIdToImageKey(presence.matchMap);
      let mode = presence.queueId ? presence.queueId : 'Custom Game';
      //No way to read scores yet
      if(presence.partySize === 1) {
        //Player is lonely
        client.setActivity({
          state: `In Game - ${capitalize(mode)}`,
          largeImageKey: map,
          largeImageText: capitalize(map),
          startTimestamp: Date.parse(convertRiotTimestampToISO(presence.queueEntryTime)),
          instance: false
        });
      } else {
        client.setActivity({
          state: `In Game - ${capitalize(mode)}`,
          details: `In a Party (${presence.partySize} of 5)`,
          largeImageKey: map,
          largeImageText: capitalize(map),
          startTimestamp: Date.parse(convertRiotTimestampToISO(presence.queueEntryTime)),
          instance: false
        });
      }
    }
    //If player is in queue
    else if(presence.partyState.toLowerCase() === 'matchmaking') {
      let mode = presence.queueId;
      if(presence.partySize === 1) {
        //Player is lonely
        client.setActivity({
          state: `In Queue - ${capitalize(mode)}`,
          largeImageKey: 'valorant_logo',
          largeImageText: 'VALORANT - In Queue',
          smallImageKey: mode,
          smallImageText: capitalize(mode),
          startTimestamp: Date.parse(convertRiotTimestampToISO(presence.queueEntryTime)),
          instance: false
        });
      } else {
        client.setActivity({
          state: `In Game - ${capitalize(mode)}`,
          details: `In a Party (${presence.partySize} of 5)`,
          largeImageKey: 'valorant_logo',
          largeImageText: 'VALORANT - In Queue',
          smallImageKey: mode,
          smallImageText: capitalize(mode),
          startTimestamp: Date.parse(convertRiotTimestampToISO(presence.queueEntryTime)),
          instance: false
        });
      }
    }
    //If player is in party
    else if(presence.partySize > 1) {
      client.setActivity({
        state: `In Menus`,
        details: `In a Party (${presence.partySize} of 5)`,
        largeImageKey: 'valorant_logo',
        largeImageText: 'VALORANT - In Party',
        instance: false
      });
    }
    //If player is 'Available'
    else {
      //Player is lonely
      client.setActivity({
        state: `In Menus`,
        largeImageKey: 'valorant_logo',
        largeImageText: 'VALORANT - Available',
        instance: false
      });
    }
  }
}

const isGameLaunched = async () => {
  let lockfileInfo = getLockfileInfo();
  let headers = {
    'Authorization': `Basic ${new Buffer('riot:' + lockfileInfo.key).toString('base64')}`
  };
  let presenceData;
  try {
    presenceData = (await httpClient.get(`https://127.0.0.1:${lockfileInfo.port}${endpoints.presences}`, {headers: headers})).data.presences;
  } catch (e) {
    //Gracefully fail
    return false;
  }
  return presenceData.length !== 0;
}

const fetchGameInfo = async () => {
  if(!riotClientLaunched) {
    //This should not be called if Riot Client is not launched.
    throw new Error('The Developer is incompetent.');
  }
  let lockfileInfo = getLockfileInfo();
  let headers = {
    'Authorization': `Basic ${new Buffer('riot:' + lockfileInfo.key).toString('base64')}`
  };
  let sessionData;
  try{
    sessionData = (await httpClient.get(`https://127.0.0.1:${lockfileInfo.port}${endpoints.session}`, {headers: headers})).data;
  } catch (e) {
    return {state: 'closed'};
  }
  //If away, return immediately.
  if(sessionData.state === 'away') {
    return {state: 'away'};
  }
  let presenceData;
  try{
    presenceData = (await httpClient.get(`https://127.0.0.1:${lockfileInfo.port}${endpoints.presences}`, {headers: headers})).data.presences;
  } catch (e) {
    return {state: 'closed'};
  }
  let selfPresence = {};
  presenceData.forEach((presence) => {
    if(presence.puuid === sessionData.puuid) {
      if(presence.product !== 'valorant') {
        //Not VALORANT, don't update presence
        return {notValorant: true};
      }
      selfPresence = Object.assign(selfPresence, sessionData, JSON.parse(new Buffer(presence.private, 'base64').toString('utf8')));
    }
  });
  if(selfPresence.sessionLoopState.toLowerCase() === 'ingame') {
    //TODO: Call Riot Match API endpoint (RSO)
  }
  return selfPresence;
}

const getLockfileInfo = () => {
  if(!riotClientLaunched) {
    //This should not be called if game is not launched.
    throw new Error('The Developer is incompetent.');
  }
  if(lockfileCache) {
    return lockfileCache;
  }
  let contents = fs.readFileSync(lockfilePath, {encoding: 'utf8', flag: 'r'});
  let args = contents.split(':');
  lockfileCache = {
    port: args[2],
    key: args[3]
  };
  return lockfileCache;
}

const capitalize = (s) => {
  if (typeof s !== 'string') {
    throw new Error('The Developer is incompetent');
  }
  if(s.toLowerCase() === 'spikerush') {
    return 'Spike Rush';
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const convertMapIdToImageKey = (id) => {
  let args = id.split('\/');
  let name = args[args.length - 1].toLowerCase();
  //Riot why
  switch(name) {
    case 'bonsai':
      return 'split';
    case 'duality':
      return 'bind';
    case 'ascent':
      return 'ascent';
    case 'triad':
      return 'haven';
    case 'port':
      return 'icebox';
  }
}

const convertRiotTimestampToISO = (timestamp) => {
  //God please someone enlighten me on why Riot isn't using ISO Timestamps
  let args = timestamp.split('-');
  args[0] = args[0].replaceAll('.', '-');
  args[1] = args[1].replaceAll('.', ':');
  return args[0] + 'T' + args[1];
}

const shutdown = () => {
  if(ws) {
    ws.close();
  }
  process.exit(0);
}

setInterval(() => {
  updatePresence();
}, 20000);

client.login({clientId});