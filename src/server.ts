import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import "./config/db.ts"; // ✅ correct for ts-node

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

import patientRoutes from "./routes/patientRoutes.ts";
app.use("/api/patients", patientRoutes);

import authRoutes from "./routes/authRoutes.ts";
app.use("/auth", authRoutes);

app.get("/", (req, res) => {
  res.status(200).set({
    "Content-Type": "text/html",
    "Access-Control-Allow-Origin": "*",
  });
  res.end("<h2>✅ HealthLink API is running and connected to PostgreSQL!</h2>");
});


const PORT = process.env.PORT || 5050;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
