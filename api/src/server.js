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
    const result = await pool
      .request()
      .input("code", sql.VarChar(50), req.params.code)
      .query(
        "SELECT TOP 1 Code as code, Name as name, Designation as designation, Department as department, PhotoUrl as imageUrl FROM Employees WHERE Code = @code"
      );
    res.json({ employee: result.recordset[0] || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch employee" });
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

    // Resolve employee_id based on employeeCode
    let employeeId;
    try {
      const empResult = await pool
        .request()
        .input("code", sql.VarChar(50), employeeCode)
        .query("SELECT TOP 1 Id AS id FROM Employees WHERE Code = @code");
      employeeId = empResult.recordset?.[0]?.id;
    } catch (lookupErr) {
      // If Employees table doesn't exist, we'll try to parse employeeCode as ID below
      employeeId = undefined;
    }
    if (!employeeId) {
      const parsed = Number(employeeCode);
      if (Number.isFinite(parsed)) {
        employeeId = parsed;
      }
    }
    if (!employeeId) {
      return res.status(404).json({ error: "Employee not found for code", code: employeeCode });
    }

    // Check if the lowercase `attendance` table exists; if not, fall back to legacy insert
    const attendanceColumns = await getAttendanceColumns(pool);
    if (!attendanceColumns.length) {
      // Legacy/alternate schema: insert into "Attendance" table with code-based columns
      await pool
        .request()
        .input("employeeCode", sql.VarChar(50), employeeCode)
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

