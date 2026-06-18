import type { Request, Response, NextFunction } from 'express'

export function loggerMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = Date.now()
  const sender = req.sender ?? 'unknown'

  res.on('finish', () => {
    const duration = Date.now() - start
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        sender,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration,
      }),
    )
  })

  next()
}
