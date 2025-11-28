import express from "express";
type Request = express.Request;
type Response = express.Response;

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import db from "../config/db.ts";

// Helper to generate JWT
const generateToken = (user: any) => {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role, // IMPORTANT for mobile redirect
    },
    process.env.JWT_SECRET || "healthlink_secret",
    { expiresIn: "7d" }
  );
};

// ============================
// REGISTER USER
// ============================

export const registerUser = async (req: Request, res: Response) => {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: "All fields are required" });
    }

    // Check if user exists
    const existingUser = await db.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ message: "Email already registered" });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Insert user
    const newUser = await db.query(
      "INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role",
      [name, email, hashedPassword, role]
    );

    const token = generateToken(newUser.rows[0]);

    return res.status(201).json({
      message: "User registered successfully",
      token,
      user: newUser.rows[0],
    });
  } catch (err: any) {
    console.error("Register Error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ============================
// LOGIN USER
// ============================

export const loginUser = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    // Check if user exists
    const userResult = await db.query("SELECT * FROM users WHERE email = $1", [
      email,
    ]);

    if (userResult.rows.length === 0) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    const user = userResult.rows[0];

    // Compare passwords
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    // Create JWT
    const token = generateToken(user);

    return res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
      },
    });
  } catch (err: any) {
    console.error("Login Error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};
