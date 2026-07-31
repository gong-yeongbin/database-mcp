// DATABASE_URL 등 환경변수를 파싱해 mssql 접속 설정으로 변환하는 모듈

import type { config as MssqlConfig } from 'mssql';

export interface Config {
    db: MssqlConfig;
    /** 프로시저 실행 tool 을 등록할지. 프로시저 본문은 데이터를 바꿀 수 있다. */
    allowProcedure: boolean;
    maxRows: number;
}

const DEFAULT_PORT = 1433;
const DEFAULT_MAX_ROWS = 1000;

/**
 * `mssql://user:pass@host:1433/dbname` 형태의 URL을 파싱한다.
 *
 * mssql 패키지의 parseConnectionString 은 ADO.NET 문법만 이해하고,
 * URL 을 넘기면 에러 없이 빈 설정을 돌려주기 때문에 직접 파싱한다.
 */
export function parseDatabaseUrl(raw: string): MssqlConfig {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`DATABASE_URL 형식이 올바르지 않습니다: ${raw}`);
    }

    if (url.protocol !== 'mssql:') {
        throw new Error(`DATABASE_URL 은 mssql:// 로 시작해야 합니다. 현재: ${url.protocol}//`);
    }
    if (!url.hostname) {
        throw new Error('DATABASE_URL 에 호스트가 없습니다.');
    }

    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!database) {
        throw new Error('DATABASE_URL 에 데이터베이스 이름이 없습니다. 예: mssql://user:pass@host:1433/mydb');
    }
    if (!url.username) {
        throw new Error('DATABASE_URL 에 사용자 이름이 없습니다.');
    }

    // 비밀번호에 @ ; / 같은 문자가 흔해서 URL 인코딩된 값이 들어온다.
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);

    const q = url.searchParams;

    return {
        server: url.hostname,
        port: url.port ? Number(url.port) : DEFAULT_PORT,
        database,
        user,
        password,
        options: {
            encrypt: q.get('encrypt') !== 'false',
            trustServerCertificate: q.get('trustServerCertificate') !== 'false',
        },
        // stdio 서버는 호출자 하나를 순차 처리하므로 커넥션을 많이 열 필요가 없다.
        pool: { max: 2, min: 0, idleTimeoutMillis: 30_000 },
        // 폭주 쿼리가 서버를 붙잡지 않고 깨끗하게 실패하도록 한다.
        requestTimeout: 30_000,
    };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const raw = env.DATABASE_URL;
    if (!raw) {
        throw new Error('DATABASE_URL 환경변수가 필요합니다. 예: mssql://user:pass@host:1433/mydb');
    }

    let maxRows = DEFAULT_MAX_ROWS;
    if (env.MAX_ROWS !== undefined) {
        const parsed = Number(env.MAX_ROWS);
        if (!Number.isInteger(parsed) || parsed < 1) {
            throw new Error(`MAX_ROWS 는 1 이상의 정수여야 합니다. 현재: ${env.MAX_ROWS}`);
        }
        maxRows = parsed;
    }

    return {
        db: parseDatabaseUrl(raw),
        allowProcedure: env.ALLOW_PROCEDURE === 'true',
        maxRows,
    };
}
