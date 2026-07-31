// SQL Server 에 접속해 스키마 조회와 쿼리 실행을 담당하는 드라이버

import sql from 'mssql';
import type {
    Column,
    Driver,
    Parameter,
    ProcedureRef,
    ProcedureResult,
    QueryResult,
    TableRef,
} from './driver.ts';
import { assertProcedureCall, assertReadOnly } from './driver.ts';

const LIST_TABLES = `
SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS [name], TABLE_TYPE AS [type]
FROM INFORMATION_SCHEMA.TABLES
ORDER BY TABLE_SCHEMA, TABLE_NAME
`;

const DESCRIBE_TABLE = `
SELECT
  c.COLUMN_NAME AS [name],
  c.DATA_TYPE   AS [type],
  CASE c.IS_NULLABLE WHEN 'YES' THEN 1 ELSE 0 END AS [nullable],
  c.CHARACTER_MAXIMUM_LENGTH AS [maxLength],
  c.COLUMN_DEFAULT           AS [colDefault],
  CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS [isPrimaryKey]
FROM INFORMATION_SCHEMA.COLUMNS c
LEFT JOIN (
  SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
  JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
    ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
   AND tc.TABLE_SCHEMA    = ku.TABLE_SCHEMA
  WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
) pk
  ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA
 AND pk.TABLE_NAME   = c.TABLE_NAME
 AND pk.COLUMN_NAME  = c.COLUMN_NAME
WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
ORDER BY c.ORDINAL_POSITION
`;

const LIST_PROCEDURES = `
SELECT s.name AS [schema], p.name AS [name], p.modify_date AS [modifyDate]
FROM sys.procedures p
JOIN sys.schemas s ON s.schema_id = p.schema_id
ORDER BY s.name, p.name
`;

const DESCRIBE_PROCEDURE = `
SELECT
  pr.name                       AS [name],
  TYPE_NAME(pr.user_type_id)    AS [type],
  pr.max_length                 AS [maxLength],
  pr.is_output                  AS [isOutput]
FROM sys.procedures p
JOIN sys.schemas s    ON s.schema_id = p.schema_id
JOIN sys.parameters pr ON pr.object_id = p.object_id
WHERE s.name = @schema AND p.name = @name
ORDER BY pr.parameter_id
`;

/**
 * arrayRowMode 결과를 QueryResult 로 변환한다.
 *
 * @types/mssql 12.3 의 IResult 에는 columns 가 없어 캐스팅한다.
 * columns 는 recordset 별 배열이라 첫 번째만 쓴다.
 */
function toQueryResult(result: sql.IResult<unknown>, maxRows: number): QueryResult {
    const meta = (result as unknown as { columns?: sql.IColumnMetadata[] }).columns?.[0];
    const columns = meta ? Object.values(meta).sort((a, b) => a.index - b.index).map((c) => c.name) : [];

    const all = (result.recordset ?? []) as unknown as unknown[][];
    const totalRows = all.length;
    const truncated = totalRows > maxRows;
    const rows = truncated ? all.slice(0, maxRows) : all;

    return {
        columns,
        rows,
        rowCount: rows.length,
        totalRows,
        truncated,
        multipleResultSets: (result.recordsets as unknown[]).length > 1,
    };
}

export class MssqlDriver implements Driver {
    private pool?: Promise<sql.ConnectionPool>;
    private readonly cfg: sql.config;

    constructor(cfg: sql.config) {
        this.cfg = cfg;
    }

    /**
     * 첫 호출에서 연결한다.
     *
     * MCP 클라이언트는 서버를 시작 시 즉시 spawn 하므로, 시작 시점에
     * 연결하면 DB 장애가 프로세스 크래시로 나타나 원인을 알기 어렵다.
     * 지연 연결이면 평범한 tool 에러가 되고 DB 복구 후 회복된다.
     *
     * 실패한 promise 는 캐시하지 않는다. 한 번의 장애가 프로세스를
     * 영구히 오염시키지 않게 하기 위한 것이다.
     */
    private getPool(): Promise<sql.ConnectionPool> {
        this.pool ??= new sql.ConnectionPool(this.cfg).connect().catch((e: unknown) => {
            this.pool = undefined;
            throw e;
        });
        return this.pool;
    }

    async listTables(): Promise<TableRef[]> {
        const pool = await this.getPool();
        const result = await pool.request().query<TableRef>(LIST_TABLES);
        return result.recordset;
    }

    async describeTable(schema: string, table: string): Promise<Column[]> {
        const pool = await this.getPool();
        const result = await pool
            .request()
            .input('schema', sql.NVarChar, schema)
            .input('table', sql.NVarChar, table)
            .query<{
                name: string;
                type: string;
                nullable: number;
                maxLength: number | null;
                colDefault: string | null;
                isPrimaryKey: number;
            }>(DESCRIBE_TABLE);

        return result.recordset.map((r) => ({
            name: r.name,
            type: r.type,
            nullable: r.nullable === 1,
            maxLength: r.maxLength,
            default: r.colDefault,
            isPrimaryKey: r.isPrimaryKey === 1,
        }));
    }

    async query(
        text: string,
        params: Record<string, unknown>,
        maxRows: number,
    ): Promise<QueryResult> {
        assertReadOnly(text);

        const pool = await this.getPool();
        const request = pool.request();
        request.arrayRowMode = true;
        for (const [k, v] of Object.entries(params)) {
            request.input(k, v);
        }

        const result = await request.query(text);
        return toQueryResult(result, maxRows);
    }

    async listProcedures(): Promise<ProcedureRef[]> {
        const pool = await this.getPool();
        const result = await pool.request().query<ProcedureRef>(LIST_PROCEDURES);
        return result.recordset;
    }

    async describeProcedure(schema: string, name: string): Promise<Parameter[]> {
        const pool = await this.getPool();
        const result = await pool
            .request()
            .input('schema', sql.NVarChar, schema)
            .input('name', sql.NVarChar, name)
            .query<{
                name: string;
                type: string;
                maxLength: number | null;
                isOutput: boolean;
            }>(DESCRIBE_PROCEDURE);

        return result.recordset.map((r) => ({
            name: r.name,
            type: r.type,
            maxLength: r.maxLength,
            isOutput: Boolean(r.isOutput),
        }));
    }

    /**
     * EXEC 문장을 그대로 실행한다.
     *
     * 프로시저는 결과 집합을 돌려줄 수도 있고 행만 바꿀 수도 있어
     * 둘 다 보고한다. 값이 SQL 텍스트에 박히는 형태라서 호출자가
     * 이스케이프를 책임진다.
     */
    async callProcedure(text: string, maxRows: number): Promise<ProcedureResult> {
        assertProcedureCall(text);

        const pool = await this.getPool();
        const request = pool.request();
        request.arrayRowMode = true;

        const result = await request.query(text);
        const rowsAffected = result.rowsAffected.reduce((a, b) => a + b, 0);

        return { result: toQueryResult(result, maxRows), rowsAffected };
    }

    async close(): Promise<void> {
        if (!this.pool) return;
        const pending = this.pool;
        this.pool = undefined;
        try {
            const pool = await pending;
            await pool.close();
        } catch {
            // 연결 자체가 실패했다면 닫을 것도 없다.
        }
    }
}
