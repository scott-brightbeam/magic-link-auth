// Hono adapter. Mounts the four routes under ml.basePath.
// If the app has an auth middleware, add ml.basePath and everything under it to its public paths.

export function mountMagicLink(app, ml) {
  app.get(ml.basePath, () => ml.handleSignInPage())
  app.post(`${ml.basePath}/request`, c => ml.handleRequest(c.req.raw))
  app.get(`${ml.basePath}/confirm`, c => ml.handleConfirm(c.req.raw))
  app.post(`${ml.basePath}/redeem`, c => ml.handleRedeem(c.req.raw))
  return app
}
