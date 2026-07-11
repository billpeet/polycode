/**
 * Dynamic Expo config layered over app.json.
 *
 * APP_VARIANT=development gives the dev-client build its own application id
 * and name so it can live on a device alongside the production app.
 */
module.exports = ({ config }) => {
  const isDev = process.env.APP_VARIANT === 'development'
  if (!isDev) return config
  return {
    ...config,
    name: 'PolyCode (dev)',
    android: {
      ...config.android,
      package: `${config.android.package}.dev`,
    },
    ios: {
      ...config.ios,
      bundleIdentifier: config.ios?.bundleIdentifier ? `${config.ios.bundleIdentifier}.dev` : undefined,
    },
  }
}
