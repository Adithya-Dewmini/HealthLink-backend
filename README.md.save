🏥 HealthLink Backend

HealthLink is the backend service for the HealthLink mobile app, designed to connect clinics, pharmacies, doctors, and patients.
Built with TypeScript, Express.js, and PostgreSQL (Neon DB).

⚙️ Tech Stack

Node.js + Express.js – RESTful API

TypeScript – for type safety

PostgreSQL (Neon) – database

JWT Authentication – secure access control

dotenv – environment variable management

🧰 Prerequisites

Make sure you have installed:

Node.js 22+

npm

A Neon.tech
 PostgreSQL database

🚀 Setup Instructions
1️⃣ Clone the Repository
git clone https://github.com/Adithya-Dewmini/HealthLink-backend.git
cd HealthLink-backend

2️⃣ Install Dependencies
npm install

3️⃣ Create .env File

In the root of the project, create a .env file with:

DATABASE_URL=postgresql://<username>:<password>@<host>/<dbname>?sslmode=require
JWT_SECRET=healthlink_secret
PORT=5050


💡 Replace <username>, <password>, <host>, <dbname> with your actual Neon credentials.

🧠 Run the Server

For development:

npx ts-node src/server.ts


You should see:

✅ Server running on port 5050
✅ PostgreSQL connected successfully

📡 API Routes
👩‍⚕️ Patients
Method	Endpoint	Description
POST	/api/patients	Add a new patient
GET	/api/patients	Retrieve all patients
🔐 Authentication
Method	Endpoint	Description
POST	/auth/register	Register a new user
POST	/auth/login	Login and receive JWT
🏥 Clinics
Method	Endpoint	Description
GET	/api/clinics	Get clinic list
💊 Pharmacy
Method	Endpoint	Description
GET	/api/pharmacy	Get pharmacy list
🧪 Test with cURL

Add a patient:

curl -X POST http://localhost:5050/api/patients \
-H "Content-Type: application/json" \
-d '{"name": "Adithya Dewmini", "age": 20, "gender": "Female", "contact_number": "0712345668"}'

🧾 Folder Structure
backend/
├── src/
│   ├── config/
│   │   └── db.ts
│   ├── controllers/
│   │   └── authController.ts
│   ├── middleware/
│   │   └── authenticateToken.ts
│   ├── routes/
│   │   ├── authRoutes.ts
│   │   ├── clinicRoutes.ts
│   │   ├── patientRoutes.ts
│   │   └── pharmacyRoutes.ts
│   └── server.ts
├── package.json
├── tsconfig.json
└── .env

🧩 Deployment

You can deploy this backend to:

Render

Railway

Vercel Serverless Functions

👩‍💻 Author

Adithya Dewmini
📍 Sri Lanka
GitHub: @Adithya-Dewmini
