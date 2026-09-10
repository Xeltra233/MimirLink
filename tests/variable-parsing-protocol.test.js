import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAndApplyVariables, extractVisibleContent } from '../src/variable-bridge.js';

/**
 * 回归：主回复的 UpdateVariable 协议识别（protocolPresent）
 *
 * 背景：index.js 仅在主回复“未包含有效 UpdateVariable 协议”时才额外调用变量解析模型。
 * 因此空数组 [] 必须算作“已处理”，否则会重复触发额外模型调用与二次扣费。
 */

function createSessionManager() {
    const store = new Map();
    const keyOf = (scopeOptions, key) => `${scopeOptions.scopeKey}::${key}`;
    return {
        store,
        upsertVariable(scopeOptions, record) {
            store.set(keyOf(scopeOptions, record.key), { ...record });
        },
        deleteVariableByName(scopeOptions, key) {
            store.delete(keyOf(scopeOptions, key));
        },
        getVariable(scopeOptions, key) {
            return store.get(keyOf(scopeOptions, key));
        }
    };
}

const scope = { scopeType: 'user', scopeKey: 'user:1' };

test('空数组 UpdateVariable 视为协议存在且不产生变量变更', () => {
    const sessionManager = createSessionManager();
    const result = extractAndApplyVariables(
        '<content>你好呀</content>\n<UpdateVariable>[]</UpdateVariable>',
        sessionManager,
        scope
    );

    assert.equal(result.protocolPresent, true);
    assert.equal(result.blockCount, 1);
    assert.equal(result.applied.length, 0);
    assert.equal(result.cleanedOutput, '<content>你好呀</content>');
    assert.equal(sessionManager.store.size, 0);
});

test('协议块位于 content 之后也能被识别，可见内容仍可正常提取', () => {
    const sessionManager = createSessionManager();
    const raw = '<content>正文</content>\n<UpdateVariable>\n[{"op":"replace","path":"/好感度","value":90}]\n</UpdateVariable>';
    const result = extractAndApplyVariables(raw, sessionManager, scope);

    assert.equal(result.protocolPresent, true);
    assert.equal(result.applied.length, 1);
    assert.equal(extractVisibleContent(result.cleanedOutput), '正文');
    assert.equal(sessionManager.getVariable(scope, '好感度').rawValue, '90');
    assert.equal(sessionManager.getVariable(scope, '好感度').valueType, 'number');
});

test('无协议输出时 protocolPresent 为 false，供上层触发额外解析', () => {
    const sessionManager = createSessionManager();
    const result = extractAndApplyVariables('<content>这轮没有变量</content>', sessionManager, scope);

    assert.equal(result.protocolPresent, false);
    assert.equal(result.blockCount, 0);
    assert.equal(result.applied.length, 0);
    assert.equal(extractVisibleContent(result.cleanedOutput), '这轮没有变量');
});

test('多个协议块：空数组与真实补丁并存时全部计入协议并全部剥离', () => {
    const sessionManager = createSessionManager();
    const raw = [
        '<UpdateVariable>[]</UpdateVariable>',
        '<content>正文</content>',
        '<UpdateVariable>[{"op":"add","path":"/心情","value":"开心"}]</UpdateVariable>'
    ].join('\n');
    const result = extractAndApplyVariables(raw, sessionManager, scope);

    assert.equal(result.protocolPresent, true);
    assert.equal(result.blockCount, 2);
    assert.equal(result.applied.length, 1);
    assert.ok(!result.cleanedOutput.includes('UpdateVariable'));
    assert.equal(sessionManager.getVariable(scope, '心情').rawValue, '开心');
});

test('非法 JSON 协议块不算有效协议，且不会抛出异常', () => {
    const sessionManager = createSessionManager();
    const result = extractAndApplyVariables(
        '<content>正文</content><UpdateVariable>{bad json}</UpdateVariable>',
        sessionManager,
        scope
    );

    assert.equal(result.protocolPresent, false);
    assert.equal(result.blockCount, 1);
    assert.equal(result.applied.length, 0);
    assert.equal(result.cleanedOutput, '<content>正文</content>');
});

test('remove 操作删除已有变量', () => {
    const sessionManager = createSessionManager();
    sessionManager.upsertVariable(scope, { key: '好感度', rawValue: '50', valueType: 'number', source: 'ai' });

    const result = extractAndApplyVariables(
        '<UpdateVariable>[{"op":"remove","path":"/好感度"}]</UpdateVariable>',
        sessionManager,
        scope
    );

    assert.equal(result.protocolPresent, true);
    assert.equal(result.applied.length, 1);
    assert.equal(sessionManager.getVariable(scope, '好感度'), undefined);
});

test('空输入安全返回默认结构', () => {
    const result = extractAndApplyVariables('', createSessionManager(), scope);
    assert.deepEqual(result, { cleanedOutput: '', applied: [], protocolPresent: false, blockCount: 0 });

    const nullResult = extractAndApplyVariables('<content>x</content>', null, scope);
    assert.equal(nullResult.protocolPresent, false);
});
