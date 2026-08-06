// PostgreSQL 에 접속해 스키마 조회와 쿼리 실행을 담당하는 드라이버

import pg from 'pg';
import type {
    Column,
    Driver,
    Parameter,
    ProcedureRef,
    ProcedureResult,
    QueryResult,
    TableRef,
} from './driver.ts';
import { assertProcedureCall, assertReadOnly, toPositionalParams } from './driver.ts';

const LIST_TABLES = `
SELECT table_schema AS "schema", table_name AS "name", table_type AS "type"
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name
`;

const DESCRIBE_TABLE = `
SELECT
  c.column_name               AS "name",
  c.data_type                 AS "type",
  c.is_nullable               AS "nullable",
  c.character_maximum_length  AS "maxLength",
  c.column_default            AS "colDefault",
  (pk.column_name IS NOT NULL) AS "isPrimaryKey"
FROM information_schema.columns c
LEFT JOIN (
  SELECT ku.table_schema, ku.table_name, ku.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage ku
    ON tc.constraint_name = ku.constraint_name
   AND tc.table_schema    = ku.table_schema
  WHERE tc.constraint_type = 'PRIMARY KEY'
) pk
  ON pk.table_schema = c.table_schema
 AND pk.table_name   = c.table_name
 AND pk.column_name  = c.column_name
WHERE c.table_schema = $1 AND c.table_name = $2
ORDER BY c.ordinal_position
`;

const LIST_PROCEDURES = `
SELECT r.routine_schema AS "schema", r.routine_name AS "name", r.last_altered AS "modifyDate"
FROM information_schema.routines r
WHERE r.routine_type = 'PROCEDURE'
  AND r.routine_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY r.routine_schema, r.routine_name
`;

const DESCRIBE_PROCEDURE = `
SELECT
  p.parameter_name            AS "name",
  p.data_type                 AS "type",
  p.character_maximum_length  AS "maxLength",
  p.parameter_mode            AS "mode",
  p.ordinal_position          AS "ordinal"
FROM information_schema.parameters p
JOIN information_schema.routines r
  ON r.specific_schema = p.specific_schema
 AND r.specific_name   = p.specific_name
WHERE r.routine_type = 'PROCEDURE'
  AND r.routine_schema = $1 AND r.routine_name = $2
ORDER BY p.ordinal_position
`;

function toQueryResult(result: pg.QueryArrayResult, maxRows: number): QueryResult {
    const all = result.rows as unknown[][];
    const totalRows = all.length;
    const truncated = totalRows > maxRows;
    const rows = truncated ? all.slice(0, maxRows) : all;

    return {
        columns: result.fields.map((f) => f.name),
        rows,
        rowCount: rows.length,
        totalRows,
        truncated,
        // 세미콜론 가드가 다중 문장을 막으므로 결과 집합은 항상 하나다.
        multipleResultSets: false,
    };
}

export class PostgresDriver implements Driver {
    private pool?: pg.Pool;
    private readonly cfg: pg.PoolConfig;

    constructor(cfg: pg.PoolConfig) {
        this.cfg = cfg;
    }

    /**
     * pg.Pool 은 첫 쿼리에서 연결하므로 지연 연결이 기본이다.
     * 연결 실패는 쿼리별 에러로 나타나고 풀 자체는 재사용 가능하다.
     */
    private getPool(): pg.Pool {
        if (!this.pool) {
            this.pool = new pg.Pool(this.cfg);
            // 유휴 커넥션의 네트워크 오류가 프로세스를 죽이지 않게 한다.
            this.pool.on('error', () => {});
        }
        return this.pool;
    }

    async listTables(): Promise<TableRef[]> {
        const result = await this.getPool().query<TableRef>(LIST_TABLES);
        return result.rows;
    }

    async describeTable(schema: string, table: string): Promise<Column[]> {
        const result = await this.getPool().query<{
            name: string;
            type: string;
            nullable: string;
            maxLength: number | null;
            colDefault: string | null;
            isPrimaryKey: boolean;
        }>(DESCRIBE_TABLE, [schema, table]);

        return result.rows.map((r) => ({
            name: r.name,
            type: r.type,
            nullable: r.nullable === 'YES',
            maxLength: r.maxLength,
            default: r.colDefault,
            isPrimaryKey: r.isPrimaryKey,
        }));
    }

    async query(
        text: string,
        params: Record<string, unknown>,
        maxRows: number,
    ): Promise<QueryResult> {
        assertReadOnly(text, 'postgres');
        const bound = toPositionalParams(text, params, 'postgres');

        const result = await this.getPool().query({
            text: bound.text,
            values: bound.values,
            rowMode: 'array',
        });
        return toQueryResult(result, maxRows);
    }

    async listProcedures(): Promise<ProcedureRef[]> {
        const result = await this.getPool().query<{
            schema: string;
            name: string;
            modifyDate: Date | null;
        }>(LIST_PROCEDURES);
        return result.rows.map((r) => ({ ...r, modifyDate: r.modifyDate ?? null }));
    }

    async describeProcedure(schema: string, name: string): Promise<Parameter[]> {
        const result = await this.getPool().query<{
            name: string | null;
            type: string;
            maxLength: number | null;
            mode: string;
            ordinal: number;
        }>(DESCRIBE_PROCEDURE, [schema, name]);

        return result.rows.map((r) => ({
            // 이름 없는 파라미터는 위치로 표기한다.
            name: r.name ?? `$${r.ordinal}`,
            type: r.type,
            maxLength: r.maxLength,
            isOutput: r.mode === 'OUT' || r.mode === 'INOUT',
        }));
    }

    async callProcedure(text: string, maxRows: number): Promise<ProcedureResult> {
        assertProcedureCall(text, 'postgres');

        const result = await this.getPool().query({ text, rowMode: 'array' });
        return {
            result: toQueryResult(result, maxRows),
            rowsAffected: result.rowCount ?? 0,
        };
    }

    async close(): Promise<void> {
        if (!this.pool) return;
        const pool = this.pool;
        this.pool = undefined;
        await pool.end();
    }
}
