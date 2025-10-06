import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import sql from "mssql";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const sqlConfig = {
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  database: process.env.SQL_DATABASE,
  server: process.env.SQL_SERVER,
  port: Number(process.env.SQL_PORT || 1433),
  options: {
    encrypt: (process.env.SQL_ENCRYPT || "false") === "true",
    trustServerCertificate: true,
  },
};

let poolPromise;
async function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(sqlConfig);
  }
  return poolPromise;
}

function normalizeCode(code) {
  const s = String(code || "").trim();
  return s.replace(/^[^A-Za-z0-9]+/, "");
}

// Build the base URL used in responses (e.g., photo links)
function getPublicBaseUrl() {
  const host = String(process.env.PUBLIC_HOST || "localhost").trim();
  const port = Number(process.env.PORT || 3010);
  return `http://${host}:${port}`;
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// DB connectivity health check
app.get("/db/health", async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query("SELECT 1 AS ok");
    res.json({ ok: true, dbOk: result.recordset?.[0]?.ok === 1 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "DB connect/query failed" });
  }
});

// GET /db/leave-types -> return all rows from leave_type table and log to console
app.get("/db/leave-types", async (req, res) => {
  try {
    const pool = await getPool();
    const info = await getTableSchemaAndName(pool, "leave_type");
    if (!info) {
      return res.status(404).json({ error: "leave_type table not found" });
    }
    const fullName = `${quoteIdent(info.schema)}.${quoteIdent(info.name)}`;
    const result = await pool.request().query(`SELECT * FROM ${fullName}`);
    const rows = result.recordset || [];
    console.log(`Fetched ${rows.length} rows from leave_type`);
    if (rows.length) {
      console.log("Sample rows:", rows.slice(0, Math.min(5, rows.length)));
    }
    res.json({ table: info.name, count: rows.length, rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch leave_type", details: e.message });
  }
});

// Utility to safely quote SQL identifiers (table/column names)
function quoteIdent(name) {
  return `[${String(name).replace(/]/g, ']]')}]`;
}

// Row count for a table
async function getTableRowCount(pool, tableName) {
  const r = await pool
    .request()
    .input("t", sql.NVarChar(128), tableName)
    .query(
      "SELECT SUM(p.rows) AS row_count FROM sys.tables t JOIN sys.partitions p ON t.object_id = p.object_id WHERE t.name = @t AND p.index_id IN (0,1) GROUP BY t.name"
    );
  return r.recordset?.[0]?.row_count || 0;
}

// Find first user table name that has at least one row
async function getFirstUserTableWithRows(pool) {
  const res = await pool
    .request()
    .query(
      "SELECT TOP 1 t.name, SUM(p.rows) AS row_count FROM sys.tables t JOIN sys.partitions p ON t.object_id = p.object_id WHERE t.is_ms_shipped = 0 AND p.index_id IN (0,1) GROUP BY t.name HAVING SUM(p.rows) > 0 ORDER BY row_count DESC"
    );
  return res.recordset?.[0]?.name || null;
}

async function tableHasName(pool, name) {
  const r = await pool
    .request()
    .input("t", sql.NVarChar(128), name)
    .query("SELECT 1 AS ok FROM sys.tables WHERE name = @t");
  return !!r.recordset?.[0]?.ok;
}

async function getEmployeeByCode(pool, code) {
  const normalized = normalizeCode(code);
  const candidates = [normalized];
  if (normalized !== code) candidates.push(String(code));
  // Try known tables with both normalized and raw code values
  if (await tableHasName(pool, "Employees")) {
    for (const c of candidates) {
      const r1 = await pool
        .request()
        .input("code", sql.VarChar(50), c)
        .query(
          "SELECT TOP 1 Id as id, employee_code as code, Name as name, Designation as designation, Department as department, PhotoUrl as imageUrl FROM Employees WHERE employee_code = @code"
        );
      if (r1.recordset?.[0]) return r1.recordset[0];
      const r2 = await pool
        .request()
        .input("code", sql.VarChar(50), c)
        .query(
          "SELECT TOP 1 Id as id, Code as code, Name as name, Designation as designation, Department as department, PhotoUrl as imageUrl FROM Employees WHERE Code = @code"
        );
      if (r2.recordset?.[0]) return r2.recordset[0];
    }
  }
  if (await tableHasName(pool, "employee")) {
    for (const c of candidates) {
      const r1 = await pool
        .request()
        .input("code", sql.VarChar(50), c)
        .query(
          "SELECT TOP 1 employee_id as id, employee_code as code, employee_name as name, NULL as designation, NULL as department, employee_image as imageUrl FROM employee WHERE employee_code = @code"
        );
      if (r1.recordset?.[0]) return r1.recordset[0];
      const r2 = await pool
        .request()
        .input("code", sql.VarChar(50), c)
        .query(
          "SELECT TOP 1 employee_id as id, employee_bar_code as code, employee_name as name, NULL as designation, NULL as department, employee_image as imageUrl FROM employee WHERE employee_bar_code = @code"
        );
      if (r2.recordset?.[0]) return r2.recordset[0];
    }
  }
  return null;
}

async function resolveEmployeeId(pool, code) {
  const normalized = normalizeCode(code);
  const emp = await getEmployeeByCode(pool, normalized);
  if (emp?.id != null) return emp.id;
  const parsed = Number(normalized);
  if (Number.isFinite(parsed)) return parsed;
  return null;
}

// GET /db/sample?table=TableName -> returns TOP 1 * from the specified or first table
app.get("/db/sample", async (req, res) => {
  try {
    const pool = await getPool();
    let tableName = (req.query.table || "").trim();

    if (tableName) {
      // Validate requested table exists
      const exists = await pool
        .request()
        .input("t", sql.NVarChar(128), tableName)
        .query("SELECT 1 AS ok FROM sys.tables WHERE name = @t");
      if (!exists.recordset?.[0]?.ok) {
        return res.status(404).json({ error: `Table not found: ${tableName}` });
      }
    } else {
      tableName = await getFirstUserTableWithRows(pool);
      if (!tableName) {
        return res.status(404).json({ error: "No tables with rows found" });
      }
    }

    const q = `SELECT TOP 1 * FROM ${quoteIdent(tableName)}`;
    const result = await pool.request().query(q);
    const rowCount = await getTableRowCount(pool, tableName);
    res.json({ table: tableName, rowCount, record: result.recordset?.[0] || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch sample record" });
  }
});

// GET /employees/:code
app.get("/employees/:code", async (req, res) => {
  try {
    const pool = await getPool();
    const rawCode = String(req.params.code || "").trim();
    const code = normalizeCode(rawCode);
    let employee = await getEmployeeByCode(pool, code);

    // If not found in known employee tables, try resolving numeric employee_id
    if (!employee) {
      const employeeId = await resolveEmployeeId(pool, code);
      if (employeeId) {
        employee = {
          id: employeeId,
          code: rawCode, // preserve the user-entered code (e.g. "/004")
          name: null,
          designation: null,
          department: null,
          imageUrl: null,
        };
      }
    }

    if (!employee) return res.json({ employee: null });

    // Prefer existing imageUrl; otherwise, expose our photo endpoint for this employee id
    let imageUrl = employee?.imageUrl ?? null;
    const isValidStringUrl = typeof imageUrl === "string" && imageUrl.trim() !== "";
    if (!isValidStringUrl && employee?.id != null) {
      const baseUrl = getPublicBaseUrl();
      imageUrl = `${baseUrl}/employees/${employee.id}/photo`;
    } else if (isValidStringUrl) {
      const s = imageUrl.trim();
      if (!/^https?:\/\//i.test(s)) {
        const baseUrl = getPublicBaseUrl();
        imageUrl = `${baseUrl}/${s.replace(/^\/+/, "")}`;
      }
    }
    res.json({ employee: { ...employee, imageUrl } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch employee" });
  }
});

// GET /employees/:id/photo
// Streams the employee image bytes (from `employee.employee_image`) if available,
// otherwise redirects to `Employees.PhotoUrl` when present.
app.get("/employees/:id/photo", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid employee id" });
    }
    const pool = await getPool();

    // Try varbinary image from `employee` table
    if (await tableHasName(pool, "employee")) {
      const r = await pool
        .request()
        .input("id", sql.Int, id)
        .query("SELECT TOP 1 employee_image AS img FROM employee WHERE employee_id = @id");
      const buf = r.recordset?.[0]?.img;
      if (buf) {
        // Detect common image formats by magic numbers
        let contentType = "application/octet-stream";
        if (Buffer.isBuffer(buf)) {
          const b0 = buf[0], b1 = buf[1], b2 = buf[2], b3 = buf[3];
          if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) contentType = "image/jpeg";
          else if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) contentType = "image/png";
          else if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46 && b3 === 0x38) contentType = "image/gif";
        }
        res.setHeader("Content-Type", contentType);
        return res.send(buf);
      }
    }

    // Fallback: redirect to PhotoUrl from `Employees` table
    if (await tableHasName(pool, "Employees")) {
      const r = await pool
        .request()
        .input("id", sql.Int, id)
        .query("SELECT TOP 1 PhotoUrl AS url FROM Employees WHERE Id = @id");
      const url = r.recordset?.[0]?.url;
      if (url) {
        return res.redirect(url);
      }
    }

    return res.status(404).json({ error: "Employee photo not found" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to fetch employee photo" });
  }
});

// GET /employees/:code/attendance-times
// Returns employee details along with today's first check-in and last check-out times.
app.get("/employees/:code/attendance-times", async (req, res) => {
  const rawCode = String(req.params.code || "").trim();
  const code = normalizeCode(rawCode);
  if (!code) return res.status(400).json({ error: "Missing employee code" });
  try {
    const pool = await getPool();
    let employee = await getEmployeeByCode(pool, code);

    // Detect attendance schema
    const attendanceColumns = await getAttendanceColumns(pool);
    let schema = attendanceColumns.length ? "attendance" : "legacy";

    let inTime = null;
    let outTime = null;

    if (!attendanceColumns.length) {
      // Legacy Attendance(EmployeeCode, TimeStamp, Reason, Type)
      const rIn = await pool
        .request()
        .input("employeeCode", sql.VarChar(50), code)
        .query(
          "SELECT TOP 1 TimeStamp AS ts FROM Attendance WHERE EmployeeCode = @employeeCode AND LOWER(Type) = 'in' AND CAST(TimeStamp AS date) = CAST(GETDATE() AS date) ORDER BY TimeStamp ASC"
        );
      const rOut = await pool
        .request()
        .input("employeeCode", sql.VarChar(50), code)
        .query(
          "SELECT TOP 1 TimeStamp AS ts FROM Attendance WHERE EmployeeCode = @employeeCode AND LOWER(Type) = 'out' AND CAST(TimeStamp AS date) = CAST(GETDATE() AS date) ORDER BY TimeStamp DESC"
        );
      inTime = rIn.recordset?.[0]?.ts ? new Date(rIn.recordset[0].ts).toISOString() : null;
      outTime = rOut.recordset?.[0]?.ts ? new Date(rOut.recordset[0].ts).toISOString() : null;
      // If employee not found in tables, synthesize with raw code when possible
      if (!employee) {
        const empId = await resolveEmployeeId(pool, code);
        if (empId) {
          employee = { id: empId, code: rawCode, name: null, designation: null, department: null, imageUrl: null };
        }
      }
      // Inject imageUrl fallback for legacy schema
      let imageUrl = employee?.imageUrl ?? null;
      const isValidStringUrl = typeof imageUrl === "string" && imageUrl.trim() !== "";
      if (!isValidStringUrl && employee?.id != null) {
        const baseUrl = getPublicBaseUrl();
        imageUrl = `${baseUrl}/employees/${employee.id}/photo`;
      } else if (isValidStringUrl) {
        const s = imageUrl.trim();
        if (!/^https?:\/\//i.test(s)) {
          const baseUrl = getPublicBaseUrl();
          imageUrl = `${baseUrl}/${s.replace(/^\/+/, "")}`;
        }
      }
      const employeeOut = employee ? { ...employee, code: rawCode, imageUrl } : null;
      return res.json({ employee: employeeOut, today: { inTime, outTime }, schema, employee_code: rawCode });
    }

    // Current attendance schema
    // Resolve employee_id (Code in Employees or parse numeric code)
    const employeeId = await resolveEmployeeId(pool, code);
    if (!employeeId) {
      return res.status(404).json({ error: "Employee not found for code", code });
    }

    const info = await getTableSchemaAndName(pool, "attendance");
    const fullName = `${quoteIdent(info.schema)}.${quoteIdent(info.name)}`;
    const dateCol = attendanceColumns.find((c) => ["datetime", "datetime2", "smalldatetime", "date"].includes(String(c.type).toLowerCase()));

    if (!dateCol) {
      // No date/time column; cannot compute today's times reliably
      return res.json({ employee, today: { inTime: null, outTime: null }, schema, employee_id: employeeId });
    }

    const qIn = `SELECT MIN(${quoteIdent(dateCol.column)}) AS inTime FROM ${fullName} WHERE ${quoteIdent("employee_id")} = @employee_id AND ${quoteIdent("attendance_type")} = 'In' AND CAST(${quoteIdent(dateCol.column)} AS date) = CAST(GETDATE() AS date)`;
    const qOut = `SELECT MAX(${quoteIdent(dateCol.column)}) AS outTime FROM ${fullName} WHERE ${quoteIdent("employee_id")} = @employee_id AND ${quoteIdent("attendance_type")} = 'Out' AND CAST(${quoteIdent(dateCol.column)} AS date) = CAST(GETDATE() AS date)`;
    const rIn = await pool.request().input("employee_id", sql.Int, employeeId).query(qIn);
    const rOut = await pool.request().input("employee_id", sql.Int, employeeId).query(qOut);
    inTime = rIn.recordset?.[0]?.inTime ? new Date(rIn.recordset[0].inTime).toISOString() : null;
    outTime = rOut.recordset?.[0]?.outTime ? new Date(rOut.recordset[0].outTime).toISOString() : null;
    // If employee not found in tables, synthesize with raw code
    if (!employee) {
      employee = { id: employeeId, code: rawCode, name: null, designation: null, department: null, imageUrl: null };
    }
    // Inject imageUrl fallback for attendance schema
    let imageUrl = employee?.imageUrl ?? null;
    const isValidStringUrl = typeof imageUrl === "string" && imageUrl.trim() !== "";
    if (!isValidStringUrl && employee?.id != null) {
      const baseUrl = getPublicBaseUrl();
      imageUrl = `${baseUrl}/employees/${employee.id}/photo`;
    } else if (isValidStringUrl) {
      const s = imageUrl.trim();
      if (!/^https?:\/\//i.test(s)) {
        const baseUrl = getPublicBaseUrl();
        imageUrl = `${baseUrl}/${s.replace(/^\/+/, "")}`;
      }
    }
    const employeeOut = employee ? { ...employee, code: rawCode, imageUrl } : null;
    return res.json({ employee: employeeOut, today: { inTime, outTime }, schema, employee_id: employeeId, employee_code: rawCode });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to get employee attendance times", details: e.message });
  }
});

// GET /attendance/status/:code
// Returns current status (IN/OUT) based on latest record for today (if possible),
// including latest reason and timestamp. Supports legacy `Attendance` and
// current `attendance` table schemas.
app.get("/attendance/status/:code", async (req, res) => {
  const rawCode = String(req.params.code || "").trim();
  const normalizedCode = normalizeCode(rawCode);
  if (!normalizedCode) return res.status(400).json({ error: "Missing employee code" });
  try {
    const pool = await getPool();
    const attendanceColumns = await getAttendanceColumns(pool);
    let status = "OUT";
    let latestReason = null;
    let latestTimestamp = null;

    // Legacy schema: Attendance(EmployeeCode, TimeStamp, Reason, Type)
    if (!attendanceColumns.length) {
      const rToday = await pool
        .request()
        .input("employeeCode", sql.VarChar(50), normalizedCode)
        .query(
          "SELECT TOP 1 Type AS type, Reason AS reason, TimeStamp AS ts FROM Attendance WHERE EmployeeCode = @employeeCode AND CAST(TimeStamp AS date) = CAST(GETDATE() AS date) ORDER BY TimeStamp DESC"
        );
      let row = rToday.recordset?.[0];
      if (!row) {
        const rAny = await pool
          .request()
          .input("employeeCode", sql.VarChar(50), normalizedCode)
          .query(
            "SELECT TOP 1 Type AS type, Reason AS reason, TimeStamp AS ts FROM Attendance WHERE EmployeeCode = @employeeCode ORDER BY TimeStamp DESC"
          );
        row = rAny.recordset?.[0];
      }
      if (row) {
        const t = String(row.type || "").trim().toLowerCase();
        status = t === "in" ? "IN" : "OUT";
        latestReason = row.reason || null;
        latestTimestamp = row.ts ? new Date(row.ts).toISOString() : null;
      }
      return res.json({ status, reason: latestReason, timestamp: latestTimestamp, schema: "legacy", employee_code: rawCode });
    }

    // Current schema: attendance(employee_id, attendance_reason, attendance_type, attendance_seqno, ...)
    // Resolve employee_id based on employeeCode
    const employeeId = await resolveEmployeeId(pool, normalizedCode);
    if (!employeeId) {
      return res.status(404).json({ error: "Employee not found for code", code: normalizedCode });
    }

    const info = await getTableSchemaAndName(pool, "attendance");
    const fullName = `${quoteIdent(info.schema)}.${quoteIdent(info.name)}`;
    const dateCol = attendanceColumns.find((c) => ["datetime", "datetime2", "smalldatetime", "date"].includes(String(c.type).toLowerCase()));
    let qLatest;
    if (dateCol) {
      qLatest = `SELECT TOP 1 ${quoteIdent("attendance_type")} AS type, ${quoteIdent("attendance_reason")} AS reason, ${quoteIdent(dateCol.column)} AS ts FROM ${fullName} WHERE ${quoteIdent("employee_id")} = @employee_id AND CAST(${quoteIdent(dateCol.column)} AS date) = CAST(GETDATE() AS date) ORDER BY ${quoteIdent("attendance_seqno")} DESC`;
    } else {
      qLatest = `SELECT TOP 1 ${quoteIdent("attendance_type")} AS type, ${quoteIdent("attendance_reason")} AS reason FROM ${fullName} WHERE ${quoteIdent("employee_id")} = @employee_id ORDER BY ${quoteIdent("attendance_seqno")} DESC`;
    }
    const rLatest = await pool.request().input("employee_id", sql.Int, employeeId).query(qLatest);
    const row = rLatest.recordset?.[0];
    if (row) {
      const t = String(row.type || "").trim().toLowerCase();
      status = t === "in" ? "IN" : "OUT";
      latestReason = row.reason || null;
      latestTimestamp = row.ts ? new Date(row.ts).toISOString() : null;
    }
    return res.json({ status, reason: latestReason, timestamp: latestTimestamp, schema: "attendance", employee_id: employeeId, employee_code: rawCode });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to get status", details: e.message });
  }
});

// POST /attendance/mark
// Accepts payload from the Flutter app and inserts into the real
// `attendance` table by resolving employee_id from employeeCode and
// mapping type to 'In'/'Out'. Also computes attendance_seqno as next value.
app.post("/attendance/mark", async (req, res) => {
  const { employeeCode, timestamp, reason, type } = req.body || {};
  if (!employeeCode || !type) {
    return res.status(400).json({ error: "Missing fields: employeeCode and type are required" });
  }
  try {
    const pool = await getPool();

    // Normalize type from UI enum (inScan/outScan) to 'In'/'Out'
    const normalizedType = String(type).toLowerCase();
    const attendanceType = normalizedType.includes("out") ? "Out" : "In";

    // Require a reason on checkout (Out)
    if (attendanceType === "Out") {
      const trimmedReason = String(reason || "").trim();
      if (!trimmedReason) {
        return res.status(400).json({ error: "Checkout requires a reason" });
      }
    }

    // Resolve employee_id based on employeeCode
    const normalizedCode = normalizeCode(employeeCode);
    const employeeId = await resolveEmployeeId(pool, normalizedCode);
    if (!employeeId) {
      return res.status(404).json({ error: "Employee not found for code", code: normalizedCode });
    }

    // Check if the lowercase `attendance` table exists; if not, fall back to legacy insert
    const attendanceColumns = await getAttendanceColumns(pool);
    if (!attendanceColumns.length) {
      // Rule: prevent multiple check-ins: if latest record today is In, disallow another In
      if (attendanceType === "In") {
        const latestToday = await pool
          .request()
          .input("employeeCode", sql.VarChar(50), normalizedCode)
          .query(
            "SELECT TOP 1 Type AS type FROM Attendance WHERE EmployeeCode = @employeeCode AND CAST(TimeStamp AS date) = CAST(GETDATE() AS date) ORDER BY TimeStamp DESC"
          );
        const latestType = String(latestToday.recordset?.[0]?.type || "").trim().toLowerCase();
        if (latestType === "in") {
          return res.status(409).json({ error: "Already checked-in; please check-out before checking-in again" });
        }
      }
      // Rule: block re-check-in after Duty Off on same day (legacy schema)
      if (attendanceType === "In") {
        const dutyOffToday = await pool
          .request()
          .input("employeeCode", sql.VarChar(50), normalizedCode)
          .query(
            "SELECT TOP 1 1 AS ok FROM Attendance WHERE EmployeeCode = @employeeCode AND LOWER(Reason) = 'duty off' AND CAST(TimeStamp AS date) = CAST(GETDATE() AS date)"
          );
        if (dutyOffToday.recordset?.[0]?.ok) {
          return res.status(409).json({ error: "Cannot check-in again after Duty Off on the same day" });
        }
      }
      // Legacy/alternate schema: insert into "Attendance" table with code-based columns
      await pool
        .request()
        .input("employeeCode", sql.VarChar(50), normalizedCode)
        .input("timestamp", sql.DateTime2, timestamp ? new Date(timestamp) : new Date())
        .input("reason", sql.VarChar(100), reason || "Duty")
        .input("type", sql.VarChar(20), attendanceType)
        .query(
          "INSERT INTO Attendance(EmployeeCode, TimeStamp, Reason, Type) VALUES (@employeeCode, @timestamp, @reason, @type)"
        );
      return res.json({ ok: true, schema: "legacy", employeeCode, type: attendanceType });
    }

    // Compute next attendance_seqno for this employee
    const seqResult = await pool
      .request()
      .input("employee_id", sql.Int, employeeId)
      .query(
        "SELECT ISNULL(MAX(attendance_seqno), 0) + 1 AS nextSeq FROM attendance WHERE employee_id = @employee_id"
      );
    const nextSeq = seqResult.recordset?.[0]?.nextSeq ?? 1;

    // Rule: block re-check-in after Duty Off on same day (attendance schema)
    if (attendanceType === "In") {
      const info = await getTableSchemaAndName(pool, "attendance");
      const fullName = `${quoteIdent(info.schema)}.${quoteIdent(info.name)}`;
      // Try to detect a timestamp/date column
      const dateCol = attendanceColumns.find((c) => ["datetime", "datetime2", "smalldatetime", "date"].includes(String(c.type).toLowerCase()));
      // Rule: prevent multiple check-ins: if latest record is In for today (or overall without date), disallow
      if (dateCol) {
        const qLatest = `SELECT TOP 1 ${quoteIdent("attendance_type")} AS type FROM ${fullName} WHERE ${quoteIdent("employee_id")} = @employee_id AND CAST(${quoteIdent(dateCol.column)} AS date) = CAST(GETDATE() AS date) ORDER BY ${quoteIdent("attendance_seqno")} DESC`;
        const rLatest = await pool.request().input("employee_id", sql.Int, employeeId).query(qLatest);
        const latestType = (rLatest.recordset?.[0]?.type || "").trim();
        if (latestType === "In") {
          return res.status(409).json({ error: "Already checked-in; please check-out before checking-in again" });
        }
      } else {
        const qLatest = `SELECT TOP 1 ${quoteIdent("attendance_type")} AS type FROM ${fullName} WHERE ${quoteIdent("employee_id")} = @employee_id ORDER BY ${quoteIdent("attendance_seqno")} DESC`;
        const rLatest = await pool.request().input("employee_id", sql.Int, employeeId).query(qLatest);
        const latestType = String(rLatest.recordset?.[0]?.type || "").trim().toLowerCase();
        if (latestType === "in") {
          return res.status(409).json({ error: "Already checked-in; please check-out before checking-in again" });
        }
      }
      if (dateCol) {
        const q = `SELECT TOP 1 1 AS ok FROM ${fullName} WHERE ${quoteIdent("employee_id")} = @employee_id AND LOWER(${quoteIdent("attendance_reason")}) = 'duty off' AND CAST(${quoteIdent(dateCol.column)} AS date) = CAST(GETDATE() AS date)`;
        const r = await pool.request().input("employee_id", sql.Int, employeeId).query(q);
        if (r.recordset?.[0]?.ok) {
          return res.status(409).json({ error: "Cannot check-in again after Duty Off on the same day" });
        }
      } else {
        // Fallback: check latest record reason regardless of day
        const q = `SELECT TOP 1 attendance_reason FROM ${fullName} WHERE ${quoteIdent("employee_id")} = @employee_id ORDER BY ${quoteIdent("attendance_seqno")} DESC`;
        const r = await pool.request().input("employee_id", sql.Int, employeeId).query(q);
        const lastReason = r.recordset?.[0]?.attendance_reason;
        if (String(lastReason || '').trim().toLowerCase() === 'duty off') {
          return res.status(409).json({ error: "Cannot check-in again after Duty Off (no date column)" });
        }
      }
    }

    // Build and execute parameterized insert into `attendance`
    const info = await getTableSchemaAndName(pool, "attendance");
    const fullName = `${quoteIdent(info.schema)}.${quoteIdent(info.name)}`;
    const insertCols = [
      "employee_id",
      "attendance_reason",
      "attendance_type",
      "attendance_seqno",
    ];
    const placeholders = insertCols.map((n) => `@${n}`);
    const insertSql = `INSERT INTO ${fullName} (${insertCols.map(quoteIdent).join(", ")}) VALUES (${placeholders.join(", ")});`;

    const reqst = pool.request();
    reqst.input("employee_id", sql.Int, employeeId);
    reqst.input("attendance_reason", sql.NVarChar, reason || "Duty");
    reqst.input("attendance_type", sql.NVarChar(10), attendanceType);
    reqst.input("attendance_seqno", sql.Int, nextSeq);

    await reqst.query(insertSql);
    res.json({ ok: true, schema: "attendance", employee_id: employeeId, attendance_type: attendanceType, attendance_seqno: nextSeq });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to mark attendance", details: e.message });
  }
});

// Helpers for attendance table metadata
async function getTableSchemaAndName(pool, tableName) {
  const r = await pool
    .request()
    .input("t", sql.NVarChar(128), tableName)
    .query(
      "SELECT TOP 1 schema_name(schema_id) AS schema_name, name FROM sys.tables WHERE name = @t"
    );
  const row = r.recordset?.[0];
  if (!row) return null;
  return { schema: row.schema_name, name: row.name };
}

async function getAttendanceColumns(pool) {
  const info = await getTableSchemaAndName(pool, "attendance");
  if (!info) return [];
  const q =
    "SELECT c.name AS column_name, t.name AS data_type, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, c.is_computed, dc.definition AS default_definition " +
    "FROM sys.columns c " +
    "JOIN sys.types t ON c.user_type_id = t.user_type_id " +
    "LEFT JOIN sys.default_constraints dc ON c.default_object_id = dc.object_id " +
    "WHERE c.object_id = OBJECT_ID('" +
    info.schema +
    "." +
    info.name +
    "')";
  const r = await pool.request().query(q);
  return r.recordset.map((row) => ({
    column: row.column_name,
    type: row.data_type,
    maxLength: row.max_length,
    precision: row.precision,
    scale: row.scale,
    isNullable: row.is_nullable === true || row.is_nullable === 1,
    isIdentity: row.is_identity === true || row.is_identity === 1,
    isComputed: row.is_computed === true || row.is_computed === 1,
    hasDefault: !!row.default_definition,
  }));
}

function mapSqlTypeToMssql(type) {
  switch (String(type).toLowerCase()) {
    case "int":
      return sql.Int;
    case "bigint":
      return sql.BigInt;
    case "smallint":
      return sql.SmallInt;
    case "tinyint":
      return sql.TinyInt;
    case "bit":
      return sql.Bit;
    case "decimal":
    case "numeric":
      return sql.Decimal(18, 4);
    case "float":
      return sql.Float;
    case "real":
      return sql.Real;
    case "date":
      return sql.Date;
    case "datetime":
      return sql.DateTime;
    case "datetime2":
      return sql.DateTime2;
    case "time":
      return sql.Time;
    case "varchar":
      return sql.VarChar;
    case "nvarchar":
      return sql.NVarChar;
    case "text":
      return sql.Text;
    case "ntext":
      return sql.NText;
    default:
      return sql.NVarChar; // fallback
  }
}

// GET /attendance/required-params
app.get("/attendance/required-params", async (req, res) => {
  try {
    const pool = await getPool();
    const columns = await getAttendanceColumns(pool);
    if (!columns.length) return res.status(404).json({ error: "attendance table not found" });
    const required = columns
      .filter((c) => !c.isNullable && !c.isIdentity && !c.isComputed && !c.hasDefault)
      .map((c) => ({ name: c.column, type: c.type }));
    const optional = columns
      .filter((c) => !required.find((r) => r.name === c.column))
      .map((c) => ({ name: c.column, type: c.type, nullable: c.isNullable, identity: c.isIdentity, computed: c.isComputed, hasDefault: c.hasDefault }));
    res.json({ table: "attendance", required, optional });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to get required params" });
  }
});

// POST /attendance/insert
app.post("/attendance/insert", async (req, res) => {
  try {
    const payload = req.body || {};
    const pool = await getPool();
    const columns = await getAttendanceColumns(pool);
    if (!columns.length) return res.status(404).json({ error: "attendance table not found" });

    const required = columns.filter((c) => !c.isNullable && !c.isIdentity && !c.isComputed && !c.hasDefault);
    const allowed = columns.filter((c) => !c.isIdentity && !c.isComputed);

    const missing = required.filter((c) => !(c.column in payload));
    if (missing.length) {
      return res.status(400).json({ error: "Missing required fields", missing: missing.map((m) => m.column) });
    }

    const insertCols = allowed
      .map((c) => c.column)
      .filter((name) => payload[name] !== undefined);

    if (!insertCols.length) {
      return res.status(400).json({ error: "No insertable fields provided" });
    }

    const info = await getTableSchemaAndName(pool, "attendance");
    const fullName = `${quoteIdent(info.schema)}.${quoteIdent(info.name)}`;
    const placeholders = insertCols.map((name) => `@${name}`);
    const q = `INSERT INTO ${fullName} (${insertCols.map(quoteIdent).join(", ")}) VALUES (${placeholders.join(", ")});`;

    const reqst = pool.request();
    for (const col of allowed) {
      if (payload[col.column] !== undefined) {
        const type = mapSqlTypeToMssql(col.type);
        reqst.input(col.column, type, payload[col.column]);
      }
    }

    await reqst.query(q);
    res.json({ ok: true, insertedColumns: insertCols });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to insert attendance", details: e.message });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`API listening on :${port}`));

