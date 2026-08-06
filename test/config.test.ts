// config.ts 의 DATABASE_URL 파싱과 환경변수 처리를 검증하는 테스트

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDatabaseUrl, loadConfig } from '../src/config.ts';

test('기본 URL 을 파싱한다', () => {
    const c = parseDatabaseUrl('mssql://sa:pw@localhost:1433/mydb');
    assert.equal(c.kind, 'mssql');
    if (c.kind !== 'mssql') return;
    assert.equal(c.db.server, 'localhost');
    assert.equal(c.db.port, 1433);
    assert.equal(c.db.database, 'mydb');
    assert.equal(c.db.user, 'sa');
    assert.equal(c.db.password, 'pw');
    assert.equal(c.defaultSchema, 'dbo');
    assert.equal(c.label, 'localhost:1433/mydb');
});

test('포트가 없으면 1433 을 쓴다', () => {
    const c = parseDatabaseUrl('mssql://sa:pw@db.example.com/mydb');
    if (c.kind !== 'mssql') return assert.fail('mssql 이어야 한다');
    assert.equal(c.db.port, 1433);
    assert.equal(c.db.server, 'db.example.com');
});

test('비밀번호의 URL 인코딩을 해제한다', () => {
    // Str0ng!P@ss:word/x -> @ : / 가 인코딩된 형태
    const c = parseDatabaseUrl('mssql://sa:Str0ng%21P%40ss%3Aword%2Fx@localhost/mydb');
    if (c.kind !== 'mssql') return assert.fail('mssql 이어야 한다');
    assert.equal(c.db.password, 'Str0ng!P@ss:word/x');
    assert.equal(c.db.server, 'localhost');
    assert.equal(c.db.database, 'mydb');
});

test('사용자 이름의 URL 인코딩을 해제한다', () => {
    const c = parseDatabaseUrl('mssql://domain%5Cuser:pw@localhost/mydb');
    if (c.kind !== 'mssql') return assert.fail('mssql 이어야 한다');
    assert.equal(c.db.user, 'domain\\user');
});

test('encrypt 와 trustServerCertificate 는 기본이 true 다', () => {
    const c = parseDatabaseUrl('mssql://sa:pw@localhost/mydb');
    if (c.kind !== 'mssql') return assert.fail('mssql 이어야 한다');
    assert.equal(c.db.options?.encrypt, true);
    assert.equal(c.db.options?.trustServerCertificate, true);
});

test('query string 으로 encrypt 를 끌 수 있다', () => {
    const c = parseDatabaseUrl('mssql://sa:pw@localhost/mydb?encrypt=false&trustServerCertificate=false');
    if (c.kind !== 'mssql') return assert.fail('mssql 이어야 한다');
    assert.equal(c.db.options?.encrypt, false);
    assert.equal(c.db.options?.trustServerCertificate, false);
});

test('postgres:// 를 파싱한다', () => {
    const c = parseDatabaseUrl('postgres://app:pw@localhost/mydb');
    assert.equal(c.kind, 'postgres');
    if (c.kind !== 'postgres') return;
    assert.equal(c.db.host, 'localhost');
    assert.equal(c.db.port, 5432);
    assert.equal(c.db.database, 'mydb');
    assert.equal(c.db.user, 'app');
    assert.equal(c.db.password, 'pw');
    assert.equal(c.db.ssl, undefined);
    assert.equal(c.defaultSchema, 'public');
    assert.equal(c.label, 'localhost:5432/mydb');
});

test('postgresql:// 도 같은 드라이버다', () => {
    const c = parseDatabaseUrl('postgresql://app:pw@localhost:5433/mydb');
    assert.equal(c.kind, 'postgres');
    if (c.kind !== 'postgres') return;
    assert.equal(c.db.port, 5433);
});

test('mysql:// 를 파싱한다', () => {
    const c = parseDatabaseUrl('mysql://app:pw@localhost/mydb');
    assert.equal(c.kind, 'mysql');
    if (c.kind !== 'mysql') return;
    assert.equal(c.db.host, 'localhost');
    assert.equal(c.db.port, 3306);
    assert.equal(c.db.database, 'mydb');
    assert.equal(c.db.user, 'app');
    assert.equal(c.db.password, 'pw');
    // MySQL 은 schema = database 다.
    assert.equal(c.defaultSchema, 'mydb');
    assert.equal(c.label, 'localhost:3306/mydb');
});

test('pg/mysql 의 ssl 은 ssl=true 일 때만 켜진다', () => {
    const on = parseDatabaseUrl('postgres://app:pw@localhost/mydb?ssl=true');
    if (on.kind !== 'postgres') return assert.fail('postgres 여야 한다');
    assert.deepEqual(on.db.ssl, { rejectUnauthorized: false });

    const off = parseDatabaseUrl('mysql://app:pw@localhost/mydb?ssl=false');
    if (off.kind !== 'mysql') return assert.fail('mysql 이어야 한다');
    assert.equal(off.db.ssl, undefined);
});

test('데이터베이스 이름이 없으면 거부한다', () => {
    assert.throws(() => parseDatabaseUrl('mssql://sa:pw@localhost:1433'), /데이터베이스 이름이 없습니다/);
    assert.throws(() => parseDatabaseUrl('postgres://sa:pw@localhost/'), /데이터베이스 이름이 없습니다/);
});

test('사용자 이름이 없으면 거부한다', () => {
    assert.throws(() => parseDatabaseUrl('mysql://localhost:3306/mydb'), /사용자 이름이 없습니다/);
});

test('지원하지 않는 스킴은 거부한다', () => {
    assert.throws(() => parseDatabaseUrl('oracle://sa:pw@localhost/mydb'), /지원하지 않는 DATABASE_URL 스킴/);
});

test('URL 이 아니면 거부한다', () => {
    assert.throws(() => parseDatabaseUrl('Server=localhost;Database=mydb'), /형식이 올바르지 않습니다/);
});

test('DATABASE_URL 이 없으면 거부한다', () => {
    assert.throws(() => loadConfig({}), /DATABASE_URL 환경변수가 필요합니다/);
});

test('MAX_ROWS 기본값은 1000 이고 정수만 받는다', () => {
    const url = 'mssql://sa:pw@localhost/mydb';
    assert.equal(loadConfig({ DATABASE_URL: url }).maxRows, 1000);
    assert.equal(loadConfig({ DATABASE_URL: url, MAX_ROWS: '50' }).maxRows, 50);
    assert.throws(() => loadConfig({ DATABASE_URL: url, MAX_ROWS: '0' }), /1 이상의 정수/);
    assert.throws(() => loadConfig({ DATABASE_URL: url, MAX_ROWS: '-5' }), /1 이상의 정수/);
    assert.throws(() => loadConfig({ DATABASE_URL: url, MAX_ROWS: 'abc' }), /1 이상의 정수/);
    assert.throws(() => loadConfig({ DATABASE_URL: url, MAX_ROWS: '1.5' }), /1 이상의 정수/);
});
