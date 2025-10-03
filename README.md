# Employee Attendance (Flutter + Node.js API)

Employee attendance app supporting QR code, thumb scan (biometrics), and manual entry. Backend is a lightweight Node.js API wired to SQL Server.

## Prerequisites

- Flutter SDK and a recent stable channel
- Node.js 18+
- SQL Server (on-prem or Azure SQL)

## 1) Environment configuration

### Flutter app

Create `assets/.env`:

```env
API_BASE_URL=http://localhost:3000
```

Then run:

```bash
flutter pub get
```

Android permissions are handled by dependencies, but ensure camera and biometrics are enabled on device/emulator. For iOS, add usage descriptions if you target iOS.

Run the app:

```bash
flutter run
```

### Node.js API

Create `api/.env` with your SQL Server settings:

```env
SQL_SERVER=localhost
SQL_DATABASE=AttendanceDB
SQL_USER=sa
SQL_PASSWORD=YourStrong!Passw0rd
SQL_ENCRYPT=false
SQL_PORT=1433
PORT=3000
```

Install and start the API:

```bash
cd api
npm install
npm run dev
```

Health check:

```bash
curl http://localhost:3000/health
```

## 2) Database expectations

Tables expected (adjust queries in `api/src/server.js` if your schema differs):

- `Employees(Code, Name, Designation, Department, PhotoUrl)`
- `Attendance(EmployeeCode, TimeStamp, Reason, Type, Remarks)`

## 3) Key endpoints

- `GET /employees/:code` → returns `{ employee }` or `null`
- `POST /attendance/mark` → body: `{ employeeCode, timestamp, reason, type, remarks }`

## 4) Deployment notes

- Host the API on your remote server; set `API_BASE_URL` in the app to that server URL.
- Keep `.env` files out of version control if they contain secrets.
