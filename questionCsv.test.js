'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseQuestionCsv, playlistNameFromFilename } = require('./questionCsv');

const SAMPLE = [
    'id,category,question,answer_count,answers,adjudication,sources,aliases_json',
    'MS-1,Geo,A country that shares a land border with Germany,2,Austria | France,Accept Czech Republic for Czechia.,https://example.com,"{""Czechia"": [""Czech Republic""]}"',
    'MS-2,Movies,"A Pixar feature film originally released before January 1, 2010",3,"Toy Story | Monsters, Inc. | Up",Cutoff is 2009.,https://pixar.com,"{""Monsters, Inc."": [""Monsters Inc""]}"'
].join('\n');

function testSample() {
    const parsed = parseQuestionCsv(SAMPLE);
    assert.strictEqual(parsed.errors.length, 0);
    assert.strictEqual(parsed.questions.length, 2);
    assert.strictEqual(parsed.questions[0].prompt, 'A country that shares a land border with Germany');
    assert.deepStrictEqual(parsed.questions[0].correct_answers, ['Austria', 'France', 'Czechia', 'Czech Republic']);
    assert.ok(parsed.questions[1].prompt.includes('January 1, 2010'));
    assert.ok(parsed.questions[1].correct_answers.includes('Monsters, Inc.'));
    assert.ok(parsed.questions[1].correct_answers.includes('Monsters Inc'));
}

function testFilename() {
    assert.strictEqual(
        playlistNameFromFilename('C:\\Users\\liqui\\Downloads\\megasheep_2026-11-23_questions.csv'),
        'megasheep 2026-11-23 questions'
    );
}

function testLiveExport() {
    const file = path.join('C:', 'Users', 'liqui', 'Downloads', 'megasheep_2026-11-23_questions.csv');
    if (!fs.existsSync(file)) return;
    const parsed = parseQuestionCsv(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(parsed.errors.length, 0);
    assert.strictEqual(parsed.questions.length, 25);
    const pixar = parsed.questions.find((q) => /Pixar/.test(q.prompt));
    assert.ok(pixar.correct_answers.includes('WALL-E'));
    assert.ok(pixar.correct_answers.includes('Monsters Inc'));
}

testSample();
testFilename();
testLiveExport();
console.log('questionCsv.test.js ok');
