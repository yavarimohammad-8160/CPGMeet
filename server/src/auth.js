import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "cpgmeet-pilot-change-me";
// JWT_TTL default 30d — localStorage sessions survive PWA close.

export function signToken(user) {
  return jwt.sign(
    {
      id: Number(user.id),
      email: String(user.email || ""),
      role: String(user.role || "user"),
      name: String(user.name || "")
    },
    SECRET,
    { expiresIn: process.env.JWT_TTL || "30d" }
  );
}

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "unauthorized" });
  try {
    const payload = jwt.verify(token, SECRET);
    req.user = {
      id: Number(payload.id),
      role: String(payload.role || "user"),
      email: String(payload.email || ""),
      name: String(payload.name || "")
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
    email: String(payload.email || ""),
    name: String(payload.name || "")
  };
}

export { SECRET };
