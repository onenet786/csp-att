import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import sql from "mssql";

dotenv.config();

// Global error handlers to capture unexpected crashes during development
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason && reason.stack ? reason.stack : reason);
});

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

// Debug endpoint to list actual employee codes in the database
app.get("/debug/employee-codes", async (req, res) => {
  try {
    const pool = await getPool();
    
    // Get first 10 employee codes to see what's actually in the database
    const result = await pool.request().query(`
      SELECT TOP 10 employee_id, employee_code, employee_bar_code, employee_name 
      FROM employee 
      ORDER BY employee_id
    `);
    
    res.json({ employees: result.recordset });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to get employee codes", details: e.message });
  }
});

// Debug: fetch full employee row by id (development helper)
app.get('/debug/employee/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const pool = await getPool();
    const r = await pool.request().input('id', sql.Int, id).query('SELECT TOP 1 * FROM employee WHERE employee_id = @id');
    return res.json({ row: r.recordset?.[0] || null });
  } catch (e) {
    console.error('debug employee error', e);
    res.status(500).json({ error: 'DB error', details: e.message });
  }
});

// Debug: show joined values (designation, cost_centre, branch) for an employee id
app.get('/debug/employee-joins/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const pool = await getPool();
    const q = `SELECT TOP 1 
      e.employee_id AS id, 
      e.employee_code, 
      e.employee_bar_code, 
      e.employee_name, 
      e.designation_id, 
      e.cost_centre_id, 
      e.branch_id, 
      k.employee_sub_group_name, 
      d.designation_name, 
      cc.cost_centre_name, 
      b.branch_name 
    FROM employee e 
    LEFT JOIN designation d ON e.designation_id = d.designation_id 
    LEFT JOIN cost_centre cc ON e.cost_centre_id = cc.cost_centre_id 
    LEFT JOIN employee_sub_group k ON e.employee_sub_group_id = k.employee_sub_group_id 
    LEFT JOIN branch b ON e.branch_id = b.branch_id 
    WHERE e.employee_id = @id`;
    const r = await pool.request().input('id', sql.Int, id).query(q);
    const row = r.recordset?.[0] || null;

    // Also fetch the referenced designation/cost_centre/branch rows directly to compare
    const refs = {};
    if (row) {

// Temporary debug: lookup employee_sub_group by id using the helper
app.get('/debug/employee-sub-group/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const pool = await getPool();
    const s = await lookupEmployeeSubGroup(pool, id);
    res.json({ id, result: s });
  } catch (e) {
    console.error('debug employee-sub-group error', e);
    res.status(500).json({ error: 'DB error', details: e.message });
  }
});
      if (row.designation_id != null) {
        try {
          const rd = await pool.request().input('did', sql.Int, row.designation_id).query('SELECT * FROM designation WHERE designation_id = @did');
          refs.designation = rd.recordset || [];
        } catch (e) {
          refs.designationError = e.message;
        }
      }
      if (row.cost_centre_id != null) {
        try {
          const rc = await pool.request().input('ccid', sql.Int, row.cost_centre_id).query('SELECT * FROM cost_centre WHERE cost_centre_id = @ccid');
          refs.cost_centre = rc.recordset || [];
        } catch (e) {
          refs.costCentreError = e.message;
        }
      }
      if (row.branch_id != null) {
        try {
          const rb = await pool.request().input('bid', sql.Int, row.branch_id).query('SELECT * FROM branch WHERE branch_id = @bid');
          refs.branch = rb.recordset || [];
        } catch (e) {
          refs.branchError = e.message;
        }
      }
    }

    res.json({ joined: row, refs });
  } catch (e) {
    console.error('debug employee joins error', e);
    res.status(500).json({ error: 'DB error', details: e.message });
  }
});

// Debug endpoint to check database tables and sample data
app.get("/debug/tables", async (req, res) => {
  try {
    const pool = await getPool();
    
    // Get all table names
    const tablesResult = await pool.request().query(`
      SELECT TABLE_SCHEMA, TABLE_NAME 
      FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_SCHEMA, TABLE_NAME
    `);
    
    const tables = {};
    for (const table of tablesResult.recordset) {
      const tableName = table.TABLE_NAME;
      const schema = table.TABLE_SCHEMA;
      const fullName = `${schema}.${tableName}`;
      
      try {
        // Get column info
        const columnsResult = await pool.request()
          .input('schema', sql.NVarChar(128), schema)
          .input('table', sql.NVarChar(128), tableName)
          .query(`
            SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
            ORDER BY ORDINAL_POSITION
          `);
        
        // Get row count
        const countResult = await pool.request().query(`SELECT COUNT(*) as count FROM [${schema}].[${tableName}]`);
        const rowCount = countResult.recordset[0].count;
        
        // Get sample data for employee-related tables
        let sampleData = [];
        if (tableName.toLowerCase().includes('employee') && rowCount > 0) {
          const sampleResult = await pool.request().query(`SELECT TOP 3 * FROM [${schema}].[${tableName}]`);
          sampleData = sampleResult.recordset;
        }
        
        tables[fullName] = {
          columns: columnsResult.recordset,
          rowCount: rowCount,
          sampleData: sampleData
        };
      } catch (e) {
        tables[fullName] = { error: e.message };
      }
    }
    
    res.json({ tables });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to get table info", details: e.message });
  }
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
      // Don't print full row objects (may contain binary buffers). Log a safe summary instead.
      const sample = rows.slice(0, Math.min(5, rows.length)).map((r) => {
        const keys = Object.keys(r || {});
        return { keys, hasBinary: keys.some((k) => Buffer.isBuffer(r[k])) };
      });
      console.log('Sample rows metadata:', sample);
    }
    res.json({ rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch leave types" });
  }
});

// Build candidate code variants to try when resolving employee codes.
function buildCandidates(code) {
  const originalCode = String(code || "").trim();
  const candidates = [originalCode];
  
  // Also try the normalized version (without leading non-alphanumeric chars)
  const normalized = originalCode.replace(/^[^A-Za-z0-9]+/, "");
  if (normalized && normalized !== originalCode) {
    candidates.push(normalized);
  }
  
  // Try without leading zeros (e.g., '004' -> '4')
  const noLeadingZeros = normalized.replace(/^0+/, "");
  if (noLeadingZeros && noLeadingZeros !== normalized) {
    candidates.push(noLeadingZeros);
  }
  
  // Try numeric id if parseable
  const asNum = Number(normalized);
  if (Number.isFinite(asNum) && String(asNum) !== normalized) {
    candidates.push(String(asNum));
  }
  
  // Also try with leading slash (common pattern in this database)
  if (!originalCode.startsWith('/') && normalized) {
    candidates.push('/' + normalized);
  }
  
  return Array.from(new Set(candidates));
}

// Robust helper: try several likely employee_sub_group table/column name variants
// to resolve a sub-group id -> { department, name, sub_group_name } or null.
async function lookupEmployeeSubGroup(pool, esgId) {
  if (esgId == null) return null;
  const tableCandidates = [
    { schema: 'dbo', table: 'employee_sub_group' },
    { schema: 'dbo', table: 'employee_subgroup' },
    { schema: 'dbo', table: 'employee_sub_groups' },
    { schema: null, table: 'employee_sub_group' },
    { schema: null, table: 'employee_subgroup' },
  ];
  const colCandidates = ['employee_sub_group_id', 'employee_subgroup_id', 'id', 'sub_group_id'];
  const nameCandidates = ['employee_sub_group_name', 'sub_group_name', 'name', 'department'];

  for (const t of tableCandidates) {
    const fullName = t.schema ? `${quoteIdent(t.schema)}.${quoteIdent(t.table)}` : quoteIdent(t.table);
    for (const col of colCandidates) {
      const q = `SELECT TOP 1 ${nameCandidates.map((n) => quoteIdent(n)).join(', ')} FROM ${fullName} WHERE ${quoteIdent(col)} = @esg`;
      try {
        const r = await pool.request().input('esg', sql.Int, esgId).query(q);
        const found = r.recordset?.[0];
        if (found) {
          // Normalize to keys we expect
          return {
            department: found.department || null,
            name: found.name || null,
            sub_group_name: found.sub_group_name || null,
            employee_sub_group_name: found.employee_sub_group_name || null,
          };
        }
      } catch (e) {
        // ignore and try next candidate
      }
    }
  }
  return null;
}

function isMissingDepartment(val) {
  if (val == null) return true;
  if (typeof val === 'string') {
    const s = val.trim();
    if (s === '' || s === '-') return true;
  }
  return false;
}

// Return an employee object { id, code, name, designation, department, imageUrl } or null
async function getEmployeeByCode(pool, code) {
  const candidates = buildCandidates(code);
  console.log(`Looking for employee with code: ${code}, candidates: ${candidates.join(', ')}`);

  // Try the employee table first (this is what actually exists in the database)
  if (await tableHasName(pool, "employee")) {
    for (const c of candidates) {
      console.log(`Trying candidate: ${c} in employee table`);
      try {
        // Search by employee_code (include designation and department via joins)
        const r1 = await pool
          .request()
          .input("code", sql.VarChar(50), c)
          .query(
  "SELECT TOP 1 e.employee_id AS id, e.employee_code AS code, e.employee_name AS name, e.designation_id, e.cost_centre_id, e.branch_id, e.employee_sub_group_id, k.employee_sub_group_name AS employee_sub_group_name, d.designation_name AS designation, COALESCE(k.employee_sub_group_name, cc.cost_centre_name, b.branch_name) AS department, e.employee_image AS imageUrl FROM employee e LEFT JOIN designation d ON e.designation_id = d.designation_id LEFT JOIN cost_centre cc ON e.cost_centre_id = cc.cost_centre_id LEFT JOIN employee_sub_group k ON e.employee_sub_group_id = k.employee_sub_group_id LEFT JOIN branch b ON e.branch_id = b.branch_id WHERE e.employee_code = @code"
          );
        if (r1.recordset?.[0]) {
          const row = r1.recordset[0];
          // Avoid logging raw row which may contain binary buffers (employee_image).
          const safeRow = { id: row.id, code: row.code, name: row.name, designation: row.designation, department: row.department };
          console.log('Found employee by employee_code:', safeRow);
          // If designation/department are missing, try direct lookups by id first
            try {
            if ((row.designation == null || isMissingDepartment(row.department)) ) {
              // Try designation by designation_id
              if (row.designation == null && row.designation_id != null) {
                try {
                  const rd = await pool.request().input('did', sql.Int, row.designation_id).query('SELECT TOP 1 designation_name FROM designation WHERE designation_id = @did');
                  const dn = rd.recordset?.[0]?.designation_name;
                  if (dn) row.designation = dn;
                } catch (e) {
                  console.error('designation lookup failed', e);
                }
              }
              // Try cost_centre by cost_centre_id
              if (isMissingDepartment(row.department) && row.cost_centre_id != null) {
                try {
                  const rc = await pool.request().input('ccid', sql.Int, row.cost_centre_id).query('SELECT TOP 1 cost_centre_name FROM cost_centre WHERE cost_centre_id = @ccid');
                  const cn = rc.recordset?.[0]?.cost_centre_name;
                  if (cn) row.department = cn;
                } catch (e) {
                  console.error('cost_centre lookup failed', e);
                }
              }
              // Try branch by branch_id
              if (isMissingDepartment(row.department) && row.branch_id != null) {
                try {
                  const rb = await pool.request().input('bid', sql.Int, row.branch_id).query('SELECT TOP 1 branch_name FROM branch WHERE branch_id = @bid');
                  const bn = rb.recordset?.[0]?.branch_name;
                  if (bn) row.department = bn;
                } catch (e) {
                  console.error('branch lookup failed', e);
                }
              }
            }

            // Extra fallback: check employee_group (some DBs store department there)
            if (isMissingDepartment(row.department)) {
              try {
                // Try several likely column names in employee_group
                const colCandidates = ['department', 'dept', 'name'];
                let gdept = null;
                for (const col of colCandidates) {
                  try {
                    const q = `SELECT TOP 1 ${quoteIdent(col)} AS dept FROM employee_group WHERE employee_id = @empId`;
                    const eg = await pool.request().input('empId', sql.Int, row.id).query(q);
                    if (eg.recordset?.[0]?.dept) {
                      gdept = eg.recordset[0].dept; break;
                    }
                  } catch (_) {
                    // ignore and try next column
                  }
                }
                if (gdept) row.department = gdept;
              } catch (e) {
                console.error('employee_group lookup failed', e.message || e);
              }
            }

            // New fallback: use employee_sub_group via employee_sub_group_id (some schemas store sub-group info)
            if (isMissingDepartment(row.department) && row.employee_sub_group_id != null) {
              try {
                const s = await lookupEmployeeSubGroup(pool, row.employee_sub_group_id);
                if (s) {
                  row.department = row.department || s.department || s.name || s.sub_group_name || null;
                }
              } catch (e) {
                console.error('employee_sub_group lookup failed', e.message || e);
              }
            }

            // Extra fallback: check employee_group for department
            if (isMissingDepartment(row.department)) {
              try {
                const colCandidates = ['department', 'dept', 'name'];
                let gdept = null;
                for (const col of colCandidates) {
                  try {
                    const q = `SELECT TOP 1 ${quoteIdent(col)} AS dept FROM employee_group WHERE employee_id = @empId`;
                    const eg = await pool.request().input('empId', sql.Int, row.id).query(q);
                    if (eg.recordset?.[0]?.dept) {
                      gdept = eg.recordset[0].dept; break;
                    }
                  } catch (_) {}
                }
                if (gdept) row.department = gdept;
              } catch (e) {
                console.error('employee_group lookup failed', e.message || e);
              }
            }

            // Still missing or image missing: try Employees fallback table if present
            if ((row.designation == null || row.department == null || row.imageUrl == null) && (await tableHasName(pool, "Employees"))) {
              const fb = await pool
                .request()
                .input("id", sql.Int, row.id)
                .input("code", sql.VarChar(50), row.code || c)
                .query(
                  "SELECT TOP 1 Designation AS designation, Department AS department, PhotoUrl AS photoUrl FROM Employees WHERE Id = @id OR employee_code = @code OR Code = @code"
                );
              const f = fb.recordset?.[0];
              if (f) {
                row.designation = row.designation || f.designation || null;
                row.department = row.department || f.department || null;
                row.imageUrl = row.imageUrl || f.photoUrl || null;
              }
            }
            // employee_sub_group fallback for employee_bar_code path
            if (isMissingDepartment(row.department) && row.employee_sub_group_id != null) {
              try {
                const s = await lookupEmployeeSubGroup(pool, row.employee_sub_group_id);
                if (s) {
                  row.department = row.department || s.department || s.name || s.sub_group_name || null;
                }
              } catch (e) {
                console.error('employee_sub_group lookup failed', e.message || e);
              }
            }
          } catch (e) {
            console.error('Fallback lookup failed', e);
          }
          return { id: row.id, code: row.code || c, name: row.name || null, designation: row.designation || null, department: row.department || null, employee_sub_group_name: row.employee_sub_group_name || null, imageUrl: row.imageUrl || null };
        }
        
        // Search by employee_bar_code (include designation and department via joins)
        const r2 = await pool
          .request()
          .input("code", sql.VarChar(50), c)
          .query(
            "SELECT TOP 1 e.employee_id AS id, e.employee_bar_code AS code, e.employee_name AS name, e.designation_id, e.cost_centre_id, e.branch_id, e.employee_sub_group_id, k.employee_sub_group_name AS employee_sub_group_name, d.designation_name AS designation, COALESCE(k.employee_sub_group_name, cc.cost_centre_name, b.branch_name) AS department, e.employee_image AS imageUrl FROM employee e LEFT JOIN designation d ON e.designation_id = d.designation_id LEFT JOIN cost_centre cc ON e.cost_centre_id = cc.cost_centre_id LEFT JOIN employee_sub_group k ON e.employee_sub_group_id = k.employee_sub_group_id LEFT JOIN branch b ON e.branch_id = b.branch_id WHERE e.employee_bar_code = @code"
          );
        if (r2.recordset?.[0]) {
          const row = r2.recordset[0];
          const safeRow = { id: row.id, code: row.code, name: row.name, designation: row.designation, department: row.department };
          console.log('Found employee by employee_bar_code:', safeRow);
          try {
            if ((row.designation == null || row.department == null) ) {
              if (row.designation == null && row.designation_id != null) {
                try {
                  const rd = await pool.request().input('did', sql.Int, row.designation_id).query('SELECT TOP 1 designation_name FROM designation WHERE designation_id = @did');
                  const dn = rd.recordset?.[0]?.designation_name;
                  if (dn) row.designation = dn;
                } catch (e) {
                  console.error('designation lookup failed', e);
                }
              }
              if (row.department == null && row.cost_centre_id != null) {
                try {
                  const rc = await pool.request().input('ccid', sql.Int, row.cost_centre_id).query('SELECT TOP 1 cost_centre_name FROM cost_centre WHERE cost_centre_id = @ccid');
                  const cn = rc.recordset?.[0]?.cost_centre_name;
                  if (cn) row.department = cn;
                } catch (e) {
                  console.error('cost_centre lookup failed', e);
                }
              }
              if (row.department == null && row.branch_id != null) {
                try {
                  const rb = await pool.request().input('bid', sql.Int, row.branch_id).query('SELECT TOP 1 branch_name FROM branch WHERE branch_id = @bid');
                  const bn = rb.recordset?.[0]?.branch_name;
                  if (bn) row.department = bn;
                } catch (e) {
                  console.error('branch lookup failed', e);
                }
              }
            }
            if ((row.designation == null || row.department == null || row.imageUrl == null) && (await tableHasName(pool, "Employees"))) {
              const fb = await pool
                .request()
                .input("id", sql.Int, row.id)
                .input("code", sql.VarChar(50), row.code || c)
                .query(
                  "SELECT TOP 1 Designation AS designation, Department AS department, PhotoUrl AS photoUrl FROM Employees WHERE Id = @id OR employee_code = @code OR Code = @code"
                );
              const f = fb.recordset?.[0];
              if (f) {
                row.designation = row.designation || f.designation || null;
                row.department = row.department || f.department || null;
                row.imageUrl = row.imageUrl || f.photoUrl || null;
              }
            }
          } catch (e) {
            console.error('Fallback lookup failed', e);
          }
          return { id: row.id, code: row.code || c, name: row.name || null, designation: row.designation || null, department: row.department || null, employee_sub_group_name: row.employee_sub_group_name || null, imageUrl: row.imageUrl || null };
        }
      } catch (e) {
        console.error(`Error querying employee table for code ${c}:`, e);
      }
    }
  }

  // Try Employees table (if it exists)
  if (await tableHasName(pool, "Employees")) {
    for (const c of candidates) {
      try {
        const r = await pool
          .request()
          .input("code", sql.VarChar(50), c)
          .query(
            "SELECT TOP 1 Id as id, employee_code as code, Code as altCode, Name as name, Designation as designation, Department as department, PhotoUrl as imageUrl FROM Employees WHERE employee_code = @code OR Code = @code"
          );
        if (r.recordset?.[0]) {
          const row = r.recordset[0];
          const safeRow = { id: row.id, code: row.code || row.altCode, name: row.name, designation: row.designation, department: row.department };
          console.log('Found employee in Employees table:', safeRow);
          return {
            id: row.id,
            code: row.code || row.altCode || c,
            name: row.name || null,
            designation: row.designation || null,
            department: row.department || null,
            imageUrl: row.imageUrl || null,
          };
        }
      } catch (e) {
        console.error(`Error querying Employees table for code ${c}:`, e);
      }
    }
  }

  console.log(`No employee found for any candidate of code: ${code}`);
  return null;
}

async function resolveEmployeeId(pool, code) {
  try {
    // Use the same logic as getEmployeeByCode but just return the ID
    const employee = await getEmployeeByCode(pool, code);
    return employee ? employee.id : null;
  } catch (error) {
    console.error("Error resolving employee ID:", error);
    return null;
  }
}

// GET /employees/:code
app.get("/employees/:code", async (req, res) => {
  try {
    const pool = await getPool();
    const code = normalizeCode(req.params.code);
    
    // Fetch employee info using the comprehensive lookup function
    let employee = await getEmployeeByCode(pool, code);
    
    // Process image URL
    let imageUrl = employee?.imageUrl || "";
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
    
    // Return the employee with processed imageUrl, or null if not found
    const result = employee ? { ...employee, imageUrl } : null;
    res.json({ employee: result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch employee" });
  }
});

// GET /employees/:id/photo
// Streams the employee image bytes (from `employee.employee_image`) if available,
// otherwise redirects to `Employees.PhotoUrl` when present.
app.get("/employees/:id/photo", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid employee ID" });

  try {
    const pool = await getPool();
    
    // Try to get employee image from employee table
    try {
      const r = await pool.request()
        .input("id", sql.Int, id)
        .query("SELECT employee_image FROM employee WHERE employee_id = @id");
      
      if (r.recordset?.[0]?.employee_image) {
        const buf = r.recordset[0].employee_image;
        let contentType = "application/octet-stream";
        
        if (Buffer.isBuffer(buf)) {
          const b0 = buf[0], b1 = buf[1], b2 = buf[2], b3 = buf[3];
          if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) contentType = "image/jpeg";
          else if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) contentType = "image/png";
        }
        
        res.setHeader("Content-Type", contentType);
        return res.send(buf);
      }
    } catch (error) {
      console.error("Error fetching employee image:", error);
    }

    // Fallback: redirect to PhotoUrl from `Employees` table
    try {
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
    } catch (error) {
      console.error("Error fetching employee photo URL:", error);
    }

    return res.status(404).json({ error: "Employee photo not found" });
  } catch (error) {
    console.error("Error in employee photo endpoint:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

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
    let employeeId;
    try {
      const empResult = await pool
        .request()
        .input("code", sql.VarChar(50), code)
        .query("SELECT TOP 1 Id AS id FROM Employees WHERE Code = @code");
      employeeId = empResult.recordset?.[0]?.id;
    } catch (_) {
      employeeId = undefined;
    }
    if (!employeeId) {
      const parsed = Number(code);
      if (Number.isFinite(parsed)) employeeId = parsed;
    }
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

// Check if a table with the given name exists in the current database
async function tableHasName(pool, tableName) {
  try {
    const r = await pool
      .request()
      .input("t", sql.NVarChar(128), tableName)
      .query("SELECT 1 AS ok FROM sys.tables WHERE name = @t");
    return !!(r.recordset?.[0]?.ok);
  } catch (e) {
    console.error("tableHasName error:", e);
    return false;
  }
}

// Quote an identifier (schema/table/column) for use in dynamic SQL
function quoteIdent(name) {
  if (!name || typeof name !== "string") return name;
  return "[" + String(name).replace(/]/g, "]]") + "]";
}

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  // Keep startup log minimal to avoid accidental formatting of large objects
  console.log('API listening on port', port);
});
