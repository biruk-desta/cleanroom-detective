declare const __CLEANROOM_STATIC__: boolean;
export const STATIC_DEMO =
  typeof __CLEANROOM_STATIC__ !== 'undefined' && __CLEANROOM_STATIC__;
export const publicAsset = (filename: string) =>
  `${STATIC_DEMO ? './' : '/'}${filename}`;
