// 데이터베이스 드라이버 인터페이스와 읽기 전용 SQL 가드를 정의하는 모듈

export interface TableRef {
    schema: string;
    name: string;
    type: string;
}

export interface Column {
    name: string;
    type: string;
    nullable: boolean;
    maxLength: number | null;
    default: string | null;
    isPrimaryKey: boolean;
}

export interface QueryResult {
    columns: string[];
    rows: unknown[][];
    /** 실제로 반환한 행 수 */
    rowCount: number;
    /** 상한을 적용하기 전 전체 행 수 */
    totalRows: number;
    truncated: boolean;
    /** 결과 집합이 여러 개였는지. 첫 번째만 반환한다. */
    multipleResultSets: boolean;
}

export interface ProcedureRef {
    schema: string;
    name: string;
    modifyDate: Date | null;
}

export interface Parameter {
    name: string;
    type: string;
    maxLength: number | null;
    isOutput: boolean;
}

/** 프로시저 실행 결과. 첫 결과 집합과 영향받은 행 수를 함께 담는다. */
export interface ProcedureResult {
    result: QueryResult;
    rowsAffected: number;
}

export interface Driver {
    listTables(): Promise<TableRef[]>;
    describeTable(schema: string, table: string): Promise<Column[]>;
    query(sql: string, params: Record<string, unknown>, maxRows: number): Promise<QueryResult>;
    listProcedures(): Promise<ProcedureRef[]>;
    describeProcedure(schema: string, name: string): Promise<Parameter[]>;
    callProcedure(sql: string, maxRows: number): Promise<ProcedureResult>;
    close(): Promise<void>;
}

/** 쓰기 또는 부수 효과를 일으킬 수 있는 키워드. */
const FORBIDDEN = [
    'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'CREATE', 'ALTER',
    'TRUNCATE', 'EXEC', 'EXECUTE', 'GRANT', 'REVOKE', 'INTO',
    'BACKUP', 'RESTORE', 'SHUTDOWN', 'RECONFIGURE', 'DBCC',
];

/**
 * 주석과 문자열 리터럴을 제거한다.
 *
 * 주석을 지운 자리는 공백 하나로 바꿔서 `SEL/**\/ECT` 가 `SELECT` 로
 * 되살아나지 않게 한다. 문자열 리터럴은 내용이 검사를 오염시키지
 * 않도록 빈 리터럴로 바꾼다.
 */
function stripNoise(sql: string): string {
    let out = '';
    let i = 0;

    while (i < sql.length) {
        const two = sql.slice(i, i + 2);

        if (two === '--') {
            const nl = sql.indexOf('\n', i);
            i = nl === -1 ? sql.length : nl;
            out += ' ';
            continue;
        }

        if (two === '/*') {
            // 중첩 블록 주석을 지원한다. T-SQL 이 허용한다.
            let depth = 1;
            i += 2;
            while (i < sql.length && depth > 0) {
                if (sql.slice(i, i + 2) === '/*') {
                    depth++;
                    i += 2;
                } else if (sql.slice(i, i + 2) === '*/') {
                    depth--;
                    i += 2;
                } else {
                    i++;
                }
            }
            out += ' ';
            continue;
        }

        const ch = sql[i]!;

        if (ch === "'") {
            i++;
            while (i < sql.length) {
                if (sql[i] === "'") {
                    // '' 는 이스케이프된 인용부호다.
                    if (sql[i + 1] === "'") {
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                i++;
            }
            out += "''";
            continue;
        }

        if (ch === '[') {
            // 대괄호 식별자. 안의 내용은 키워드로 해석되지 않는다.
            const end = sql.indexOf(']', i);
            i = end === -1 ? sql.length : end + 1;
            out += 'x';
            continue;
        }

        out += ch;
        i++;
    }

    return out;
}

/**
 * 읽기 전용으로 보이지 않는 SQL 이면 예외를 던진다.
 *
 * 주의: 이것은 보안 경계가 아니다. LLM 의 실수를 막는 가드레일이다.
 * 실제 권한 통제는 읽기 전용 SQL 로그인(db_datareader)으로 해야 한다.
 */
export function assertReadOnly(sql: string): void {
    const cleaned = stripNoise(sql).trim();

    if (!cleaned) {
        throw new Error('빈 쿼리입니다.');
    }

    // 끝의 세미콜론 하나는 허용하고, 그 뒤에 내용이 있으면 거부한다.
    const withoutTrailing = cleaned.replace(/;\s*$/, '');
    if (withoutTrailing.includes(';')) {
        throw new Error('여러 문장을 한 번에 실행할 수 없습니다. query 는 SELECT 한 문장만 받습니다.');
    }

    const upper = withoutTrailing.toUpperCase();

    const firstToken = upper.match(/^[A-Z]+/)?.[0];
    if (firstToken !== 'SELECT' && firstToken !== 'WITH') {
        throw new Error(
            `query 는 SELECT 또는 WITH 로 시작해야 합니다. 현재: ${firstToken ?? withoutTrailing.slice(0, 20)}.`,
        );
    }

    for (const kw of FORBIDDEN) {
        if (new RegExp(`\\b${kw}\\b`).test(upper)) {
            throw new Error(`읽기 전용 쿼리에 ${kw} 를 쓸 수 없습니다.`);
        }
    }
}

/**
 * EXEC 한 문장으로만 보이는지 검사한다.
 *
 * assertReadOnly 와 방향이 반대다. 여기서는 EXEC 를 허용하되 문장이
 * 하나인지만 본다. 프로시저 본문이 무엇을 하는지는 알 수 없으므로
 * 이 가드는 읽기 전용을 보장하지 않는다. 문장 이어붙이기만 막는다.
 *
 * sp_executesql 은 임의 SQL 을 문자열로 받아 실행하므로, 프로시저
 * 호출만 허용한다는 전제를 무너뜨린다. 이름으로 막는다.
 */
const DYNAMIC_SQL_PROCS = ['SP_EXECUTESQL', 'SP_SQLEXEC', 'XP_CMDSHELL'];

export function assertProcedureCall(sql: string): void {
    const cleaned = stripNoise(sql).trim();

    if (!cleaned) {
        throw new Error('빈 쿼리입니다.');
    }

    const withoutTrailing = cleaned.replace(/;\s*$/, '');
    if (withoutTrailing.includes(';')) {
        throw new Error('여러 문장을 한 번에 실행할 수 없습니다. call_procedure 는 EXEC 한 문장만 받습니다.');
    }

    const upper = withoutTrailing.toUpperCase();

    const firstToken = upper.match(/^[A-Z]+/)?.[0];
    if (firstToken !== 'EXEC' && firstToken !== 'EXECUTE') {
        throw new Error(
            `call_procedure 는 EXEC 로 시작해야 합니다. 현재: ${firstToken ?? withoutTrailing.slice(0, 20)}. ` +
                '조회는 query 를 사용하세요.',
        );
    }

    // EXEC 뒤에는 프로시저 이름이 와야 한다. 금지 형태를 열거하는 대신
    // 허용 형태를 정의한다. EXEC('...') 는 이름 없는 동적 SQL 이라
    // DYNAMIC_SQL_PROCS 이름 검사에 걸리지 않고 임의 SQL 을 실행한다.
    // EXEC @sql 도 마찬가지다. 식별자만 허용하면 둘 다 막힌다.
    //
    // stripNoise 가 대괄호 식별자를 x 로 바꾸므로 [dbo].[Get Orders] 는
    // 여기서 x.x 로 보인다.
    //
    // 이름 뒤에 문자열 리터럴이 바로 붙으면 식별자가 아니다. EXEC N'...' 의
    // N 은 유니코드 접두사이지 프로시저 이름이 아니다. stripNoise 가 리터럴을
    // '' 로 비우므로 그 자리를 보고 판별한다.
    const afterKeyword = withoutTrailing.slice(firstToken.length);
    if (!/^\s+[A-Za-z_#][A-Za-z0-9_$#]*(\s*\.\s*[A-Za-z_#][A-Za-z0-9_$#]*){0,2}(?!\s*')/.test(afterKeyword)) {
        throw new Error(
            'call_procedure 는 프로시저 이름 호출만 받습니다. ' +
                "EXEC('...') 같은 동적 SQL 과 변수 실행은 허용되지 않습니다. 예: EXEC dbo.GetOrders @id = 1",
        );
    }

    for (const proc of DYNAMIC_SQL_PROCS) {
        if (new RegExp(`\\b${proc}\\b`).test(upper)) {
            throw new Error(
                `${proc} 는 임의 SQL 을 실행할 수 있어 허용되지 않습니다. 프로시저를 직접 호출하세요.`,
            );
        }
    }
}
