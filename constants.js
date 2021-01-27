import path from "path";

export const endpoints = {
  session: '/chat/v1/session',
  presences: '/chat/v4/presences'
}
export const clientId = '803787465726623754';
export const lockfilePath = path.join(process.env.LOCALAPPDATA, 'Riot Games', 'Riot Client', 'Config', 'lockfile');