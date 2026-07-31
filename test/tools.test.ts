// tool 등록과 핸들러 동작을 Driver 스텁으로 검증하는 테스트

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildServer } from '../src/index.ts';
import type {
    Column,
    Driver,
    Parameter,
    ProcedureRef,
    ProcedureResult,
    QueryResult,
    TableRef,
} from '../src/driver.ts';

function stubDriver(over: Partial<Driver> = {}): Driver {
    return {
        listTables: async (): Promise<TableRef[]> => [
            { schema: 'dbo', name: 'users', type: 'BASE TABLE' },
        ],
        describeTable: async (): Promise<Column[]> => [
            { name: 'id', type: 'int', nullable: false, maxLength: null, default: null, isPrimaryKey: true },
        ],
        query: async (): Promise<QueryResult> => ({
            columns: ['id'],
            rows: [[1]],
            rowCount: 1,
            totalRows: 1,
            truncated: false,
            multipleResultSets: false,
        }),
        listProcedures: async (): Promise<ProcedureRef[]> => [
            { schema: 'dbo', name: 'GetOrders', modifyDate: new Date('2026-01-15T00:00:00Z') },
        ],
        describeProcedure: async (): Promise<Parameter[]> => [
            { name: '@userId', type: 'int', maxLength: null, isOutput: false },
        ],
        callProcedure: async (): Promise<ProcedureResult> => ({
            result: {
                columns: ['id'],
                rows: [[7]],
                rowCount: 1,
                totalRows: 1,
                truncated: false,
                multipleResultSets: false,
            },
            rowsAffected: 1,
        }),
        close: async () => {},
        ...over,
    };
}

/** 서버를 메모리 트랜스포트로 클라이언트에 연결한다. */
async function connect(driver: Driver, allowProcedure = false) {
    const server = buildServer(driver, { allowProcedure, maxRows: 1000 });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    return { client, close: () => client.close() };
}

test('기본은 읽기 전용 tool 3개만 노출한다', async () => {
    const { client, close } = await connect(stubDriver());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['describe_table', 'list_tables', 'query']);
    await close();
});

test('list_tables 가 테이블을 렌더링한다', async () => {
    const { client, close } = await connect(stubDriver());
    const r = await client.callTool({ name: 'list_tables', arguments: {} });
    assert.match(JSON.stringify(r.content), /dbo \| users \| BASE TABLE/);
    await close();
});

test('describe_table 의 schema 기본값은 dbo 다', async () => {
    let seen = '';
    const { client, close } = await connect(
        stubDriver({
            describeTable: async (schema) => {
                seen = schema;
                return [];
            },
        }),
    );
    await client.callTool({ name: 'describe_table', arguments: { table: 'users' } });
    assert.equal(seen, 'dbo');
    await close();
});

test('query 가 params 와 maxRows 를 드라이버로 전달한다', async () => {
    let seenParams: Record<string, unknown> = {};
    let seenMax = 0;
    const { client, close } = await connect(
        stubDriver({
            query: async (_sql, params, maxRows) => {
                seenParams = params;
                seenMax = maxRows;
                return {
                    columns: [], rows: [], rowCount: 0, totalRows: 0,
                    truncated: false, multipleResultSets: false,
                };
            },
        }),
    );
    await client.callTool({
        name: 'query',
        arguments: { sql: 'SELECT * FROM t WHERE id = @id', params: { id: 7 }, maxRows: 50 },
    });
    assert.deepEqual(seenParams, { id: 7 });
    assert.equal(seenMax, 50);
    await close();
});

test('maxRows 를 생략하면 설정값을 쓴다', async () => {
    let seenMax = 0;
    const { client, close } = await connect(
        stubDriver({
            query: async (_sql, _params, maxRows) => {
                seenMax = maxRows;
                return {
                    columns: [], rows: [], rowCount: 0, totalRows: 0,
                    truncated: false, multipleResultSets: false,
                };
            },
        }),
    );
    await client.callTool({ name: 'query', arguments: { sql: 'SELECT 1' } });
    assert.equal(seenMax, 1000);
    await close();
});

test('드라이버 예외는 프로세스를 죽이지 않고 isError 로 온다', async () => {
    const { client, close } = await connect(
        stubDriver({
            listTables: async () => {
                throw new Error('Failed to connect to localhost:1433');
            },
        }),
    );
    const r = await client.callTool({ name: 'list_tables', arguments: {} });
    assert.equal(r.isError, true);
    assert.match(JSON.stringify(r.content), /Failed to connect/);
    await close();
});

test('ALLOW_PROCEDURE 면 프로시저 tool 3개가 추가된다', async () => {
    const { client, close } = await connect(stubDriver(), true);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
        'call_procedure',
        'describe_procedure',
        'describe_table',
        'list_procedures',
        'list_tables',
        'query',
    ]);
    await close();
});

// execute tool 은 제거되었다. 어떤 설정으로도 되살아나지 않아야 한다.
test('execute tool 은 어떤 설정에서도 등록되지 않는다', async () => {
    for (const allowProcedure of [false, true]) {
        const { client, close } = await connect(stubDriver(), allowProcedure);
        const { tools } = await client.listTools();
        assert.equal(tools.some((t) => t.name === 'execute'), false);
        await assert.rejects(() =>
            client.callTool({ name: 'execute', arguments: { sql: 'DELETE FROM t' } }),
        );
        await close();
    }
});

test('프로시저가 차단되면 call_procedure 는 호출 자체가 실패한다', async () => {
    const { client, close } = await connect(stubDriver());
    await assert.rejects(() =>
        client.callTool({ name: 'call_procedure', arguments: { sql: 'EXEC dbo.GetOrders' } }),
    );
    await close();
});

test('call_procedure 가 sql 과 maxRows 를 드라이버로 전달한다', async () => {
    let seenSql = '';
    let seenMax = 0;
    const { client, close } = await connect(
        stubDriver({
            callProcedure: async (sql, maxRows) => {
                seenSql = sql;
                seenMax = maxRows;
                return {
                    result: {
                        columns: [], rows: [], rowCount: 0, totalRows: 0,
                        truncated: false, multipleResultSets: false,
                    },
                    rowsAffected: 0,
                };
            },
        }),
        true,
    );
    await client.callTool({
        name: 'call_procedure',
        arguments: { sql: 'EXEC dbo.GetOrders @id = 1', maxRows: 20 },
    });
    assert.equal(seenSql, 'EXEC dbo.GetOrders @id = 1');
    assert.equal(seenMax, 20);
    await close();
});

test('call_procedure 는 결과 집합과 영향받은 행을 함께 보고한다', async () => {
    const { client, close } = await connect(stubDriver(), true);
    const r = await client.callTool({
        name: 'call_procedure',
        arguments: { sql: 'EXEC dbo.GetOrders' },
    });
    const text = JSON.stringify(r.content);
    assert.match(text, /id/);
    assert.match(text, /영향받은 행: 1/);
    await close();
});

test('결과 집합이 없는 프로시저는 행 수만 알린다', async () => {
    const { client, close } = await connect(
        stubDriver({
            callProcedure: async () => ({
                result: {
                    columns: [], rows: [], rowCount: 0, totalRows: 0,
                    truncated: false, multipleResultSets: false,
                },
                rowsAffected: 5,
            }),
        }),
        true,
    );
    const r = await client.callTool({
        name: 'call_procedure',
        arguments: { sql: 'EXEC dbo.Refresh' },
    });
    assert.match(JSON.stringify(r.content), /완료. 영향받은 행: 5/);
    await close();
});

test('list_procedures 가 프로시저를 렌더링한다', async () => {
    const { client, close } = await connect(stubDriver(), true);
    const r = await client.callTool({ name: 'list_procedures', arguments: {} });
    assert.match(JSON.stringify(r.content), /dbo \| GetOrders/);
    await close();
});

test('describe_procedure 의 schema 기본값은 dbo 다', async () => {
    let seen = '';
    const { client, close } = await connect(
        stubDriver({
            describeProcedure: async (schema) => {
                seen = schema;
                return [];
            },
        }),
        true,
    );
    await client.callTool({ name: 'describe_procedure', arguments: { name: 'GetOrders' } });
    assert.equal(seen, 'dbo');
    await close();
});

test('call_procedure 는 destructiveHint 를 붙인다', async () => {
    const { client, close } = await connect(stubDriver(), true);
    const { tools } = await client.listTools();
    const call = tools.find((t) => t.name === 'call_procedure');
    // 프로시저 본문을 알 수 없으므로 readOnly 라고 주장하면 안 된다.
    assert.equal(call?.annotations?.readOnlyHint, undefined);
    assert.equal(call?.annotations?.destructiveHint, true);
    await close();
});
