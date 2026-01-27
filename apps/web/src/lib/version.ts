export const APP_VERSION = {
  version: process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0',
  commit: process.env.NEXT_PUBLIC_COMMIT_SHA || 'dev',
  branch: process.env.NEXT_PUBLIC_GIT_BRANCH || 'local',
  buildTime: process.env.NEXT_PUBLIC_BUILD_TIME || '',
};

export const getVersionString = () => `v${APP_VERSION.version} (${APP_VERSION.commit})`;
