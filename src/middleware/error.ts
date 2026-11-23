import { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../utils/http';

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'Not found' });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof ZodError) {
    const details: Record<string, string[]> = {};
    for (const issue of err.issues) (details[issue.path.join(".")] ??= []).push(issue.message);
    return res.status(400).json({ error: Object.values(details)[0]?.[0] ?? "Validation failed", details });
  }
  if (err?.code === 11000) return res.status(409).json({ error: 'Duplicate value', keys: err.keyValue });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
};
