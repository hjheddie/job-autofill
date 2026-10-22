// Vercel serverless entry: every /api/* request is rewritten here (see vercel.json).
import { api } from '../lib.js';

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.searchParams.get('p');
  url.searchParams.delete('p');
  if (p) url.pathname = `/api/${p}`;
  try {
    const body = await api(req, url);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(body);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
}
