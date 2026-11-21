export const SERVER_URL = process.env.SERVER_URL || 'http://localhost:9883';
export const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

export const testStorageState = {
  cookies: [],
  origins: [
    {
      origin: new URL(FRONTEND_URL).origin,
      localStorage: [
        { name: 'viewTransitionsDisabled', value: 'true' },
        { name: 'serverUrl', value: JSON.stringify(SERVER_URL) },
      ],
    },
  ],
};
