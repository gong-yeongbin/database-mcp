// 읽기 전용 SQL 가드가 우회 경로를 막는지 검증하는 테스트

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertReadOnly, assertProcedureCall } from '../src/driver.ts';

const allowed = [
    'SELECT 1',
    'select 1',
    'SELECT * FROM users',
    'SELECT * FROM users;',
    'SELECT * FROM users WHERE name = \'Alice\'',
    'SELECT TOP 10 * FROM dbo.orders ORDER BY created_at DESC',
    'WITH recent AS (SELECT * FROM orders WHERE id > 100) SELECT * FROM recent',
    'SELECT a.id, b.name FROM a JOIN b ON a.id = b.a_id',
    'SELECT COUNT(*) FROM users',
    '  SELECT 1  ',
    '-- 주석만 있는 앞줄\nSELECT 1',
    'SELECT * FROM [my table]',
    // 리터럴 안의 금지 키워드는 실제 쓰기가 아니다.
    "SELECT * FROM logs WHERE msg = 'DROP TABLE users'",
    "SELECT * FROM t WHERE note = 'insert into x'",
    // 컬럼명에 금지 키워드가 부분 문자열로 들어간 경우
    'SELECT inserted_at, created_by FROM audit',
    'SELECT execution_time FROM stats',
];

const rejected: Array<[string, string]> = [
    ['SELECT 1; DROP TABLE t', '세미콜론 스태킹'],
    ['SELECT 1;DROP TABLE t', '세미콜론 스태킹 (공백 없음)'],
    ['SELECT * INTO t2 FROM t', 'SELECT INTO 로 테이블 생성'],
    ['WITH x AS (SELECT 1 AS a) INSERT INTO t SELECT a FROM x', 'CTE 로 감싼 쓰기'],
    ["EXEC sp_executesql N'DELETE FROM users'", 'EXEC 로 우회'],
    ['EXECUTE sp_who', 'EXECUTE 로 우회'],
    ['SEL/**/ECT 1', '주석 난독화로 SELECT 위장'],
    ['SELECT 1 /* */ ; DELETE FROM t', '주석 뒤 세미콜론 스태킹'],
    ['DELETE FROM users', '직접 쓰기'],
    ['UPDATE users SET name = \'x\'', '직접 쓰기'],
    ['INSERT INTO users VALUES (1)', '직접 쓰기'],
    ['DROP TABLE users', 'DDL'],
    ['CREATE TABLE t (id INT)', 'DDL'],
    ['ALTER TABLE t ADD c INT', 'DDL'],
    ['TRUNCATE TABLE t', 'DDL'],
    ['MERGE t USING s ON t.id = s.id WHEN MATCHED THEN DELETE', 'MERGE'],
    ['GRANT SELECT ON t TO public', '권한 변경'],
    ['REVOKE SELECT ON t FROM public', '권한 변경'],
    ['SHUTDOWN', '서버 종료'],
    ['DBCC CHECKDB', 'DBCC'],
    ['BACKUP DATABASE mydb TO DISK = \'/tmp/x.bak\'', '백업'],
    ['', '빈 쿼리'],
    ['   ', '공백만'],
    ['-- 주석만', '주석만'],
    ['/* 주석만 */', '블록 주석만'],
];

for (const sql of allowed) {
    test(`허용: ${JSON.stringify(sql)}`, () => {
        assert.doesNotThrow(() => assertReadOnly(sql, 'mssql'));
    });
}

for (const [sql, why] of rejected) {
    test(`거부(${why}): ${JSON.stringify(sql)}`, () => {
        assert.throws(() => assertReadOnly(sql, 'mssql'));
    });
}

test('중첩 블록 주석을 올바르게 건너뛴다', () => {
    // 중첩 주석이 제대로 닫히면 SELECT 1 만 남는다.
    assert.doesNotThrow(() => assertReadOnly('SELECT /* 바깥 /* 안쪽 */ 여전히 주석 */ 1', 'mssql'));
    // 중첩 주석 뒤에 숨긴 쓰기는 잡아야 한다.
    assert.throws(() => assertReadOnly('SELECT /* /* */ */ 1; DROP TABLE t', 'mssql'));
});

test('이스케이프된 인용부호를 문자열 종료로 착각하지 않는다', () => {
    // 'It''s' 는 하나의 문자열이다. 뒤의 DROP 은 리터럴 밖이므로 거부해야 한다.
    assert.throws(() => assertReadOnly("SELECT 'It''s' ; DROP TABLE t", 'mssql'));
    // 리터럴 안에 있으면 허용한다.
    assert.doesNotThrow(() => assertReadOnly("SELECT 'It''s fine, no DROP here' AS msg", 'mssql'));
});

test('대괄호 식별자 안의 키워드는 무시한다', () => {
    assert.doesNotThrow(() => assertReadOnly('SELECT [insert] FROM [delete]', 'mssql'));
});

const procAllowed = [
    'EXEC dbo.GetOrders',
    'exec dbo.GetOrders',
    'EXECUTE dbo.GetOrders',
    'EXEC GetOrders',
    'EXEC dbo.GetOrders;',
    '  EXEC dbo.GetOrders  ',
    'EXEC dbo.GetOrders @userId = 42',
    "EXEC dbo.GetOrders @userId = 42, @from = '2026-01-01'",
    'EXEC [dbo].[Get Orders]',
    '-- 주석\nEXEC dbo.GetOrders',
    // 리터럴 안의 위험 키워드는 실제 실행이 아니다.
    "EXEC dbo.Log @msg = 'sp_executesql'",
];

const procRejected: Array<[string, string]> = [
    ['EXEC dbo.A; DROP TABLE t', '세미콜론 스태킹'],
    ['EXEC dbo.A;EXEC dbo.B', '세미콜론으로 두 번 호출'],
    ['EXEC dbo.A /* */ ; DELETE FROM t', '주석 뒤 세미콜론 스태킹'],
    ["EXEC sp_executesql N'DELETE FROM users'", '동적 SQL 프로시저'],
    ["EXEC sp_sqlexec 'DROP TABLE t'", '동적 SQL 프로시저'],
    ["EXEC xp_cmdshell 'dir'", '셸 실행'],
    ['SELECT * FROM users', 'SELECT 은 query 로'],
    ['DELETE FROM users', '직접 쓰기'],
    ['DROP TABLE users', 'DDL'],
    ['EX/**/EC dbo.A', '주석 난독화로 EXEC 위장'],
    ['', '빈 쿼리'],
    ['   ', '공백만'],
    ['-- 주석만', '주석만'],
    // EXEC(...) 는 이름 없는 동적 SQL 이라 프로시저 이름 차단 목록에 걸리지
    // 않는다. 괄호 형태 자체를 거부해야 임의 SQL 실행이 막힌다.
    ["EXEC('DROP TABLE users')", '괄호 동적 SQL'],
    ["EXECUTE('DELETE FROM users')", 'EXECUTE 괄호 동적 SQL'],
    ["EXEC ('UPDATE users SET a=1')", '공백 뒤 괄호 동적 SQL'],
    ["EXEC\t('INSERT INTO users VALUES(1)')", '탭 뒤 괄호 동적 SQL'],
    ["EXEC/**/('DROP TABLE users')", '주석 뒤 괄호 동적 SQL'],
    ['EXEC @sql', '변수 실행'],
    ['EXEC @rc = dbo.Foo', '반환값 대입은 변수 선언이 필요해 쓸 수 없다'],
    ['EXEC', '프로시저 이름 없음'],
    ['EXEC 1', '식별자가 아닌 이름'],
    // N 은 유니코드 리터럴 접두사다. 식별자로 오인하면 안 된다.
    ["EXEC N'DROP TABLE users'", 'N 접두사 문자열 실행'],
    ["EXEC 'DROP TABLE users'", '문자열 실행'],
];

for (const sql of procAllowed) {
    test(`프로시저 허용: ${JSON.stringify(sql)}`, () => {
        assert.doesNotThrow(() => assertProcedureCall(sql, 'mssql'));
    });
}

for (const [sql, why] of procRejected) {
    test(`프로시저 거부(${why}): ${JSON.stringify(sql)}`, () => {
        assert.throws(() => assertProcedureCall(sql, 'mssql'));
    });
}

test('프로시저 가드는 읽기 전용을 보장하지 않는다', () => {
    // 프로시저 본문이 무엇을 하는지는 이름으로 알 수 없다. 이 가드의
    // 목적은 문장 이어붙이기 차단뿐이고, 실제 통제는 SQL 권한이다.
    assert.doesNotThrow(() => assertProcedureCall('EXEC dbo.DeleteAllUsers', 'mssql'));
});
