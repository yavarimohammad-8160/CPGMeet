import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "cpgchat-pilot-change-me";

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "unauthorized" });
  try {
    const payload = jwt.verify(token, SECRET);
    req.user = {
      id: Number(payload.id),
      role: String(payload.role || "user"),
      email: String(payload.email || "")
    };
    req.token = token;
    next();
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }
}

export function verifyToken(token) {
  const payload = jwt.verify(token, SECRET);
  return {
    id: Number(payload.id),
    role: String(payload.role || "user"),
    email: String(payload.email || "")
  };
}

export { SECRET };
