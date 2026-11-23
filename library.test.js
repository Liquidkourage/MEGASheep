'use strict';

delete process.env.DATABASE_URL;
delete process.env.DATABASE_PUBLIC_URL;
process.env.MEGASHEEP_LIBRARY_FILE = require('path').join(__dirname, 'data', 'question-library.test.json');

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FILE = process.env.MEGASHEEP_LIBRARY_FILE;

function resetStore() {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({
        nextQuestionId: 1,
        nextPlaylistId: 1,
        questions: [],
        playlists: []
    }, null, 2));
}

async function run() {
    const library = require('./library');
    resetStore();
    try {
        const q1 = await library.saveQuestion({ prompt: 'Capital of France?', correct_answers: ['Paris'] });
        const q2 = await library.saveQuestion({ prompt: 'Color of grass?', correct_answers: ['Green'] });
        assert.strictEqual(q1.question.id, 1);
        assert.strictEqual(q2.question.id, 2);

        const playlist = await library.savePlaylist({ name: 'Pub quiz' });
        assert.strictEqual(playlist.playlist.name, 'Pub quiz');
        await library.setQuestionPlaylists(q1.question.id, [playlist.playlist.id]);
        await library.setQuestionPlaylists(q2.question.id, [playlist.playlist.id]);

        const loaded = await library.loadLibrary();
        assert.strictEqual(loaded.source, 'file');
        assert.strictEqual(loaded.questions.length, 2);
        assert.strictEqual(loaded.playlists.length, 1);
        assert.deepStrictEqual(loaded.playlists[0].questionIds, [1, 2]);

        const attached = await library.questionsForPlaylists([playlist.playlist.id]);
        assert.strictEqual(attached.length, 2);
        assert.strictEqual(attached[0].prompt, 'Capital of France?');

        const second = await library.savePlaylist({ name: 'Wedding' });
        await library.setQuestionPlaylists(q1.question.id, [playlist.playlist.id, second.playlist.id]);
        const after = await library.loadLibrary();
        const pub = after.playlists.find((p) => p.name === 'Pub quiz');
        const wedding = after.playlists.find((p) => p.name === 'Wedding');
        assert.deepStrictEqual(pub.questionIds, [2, 1]);
        assert.deepStrictEqual(wedding.questionIds, [1]);

        const fromBoth = await library.questionsForPlaylists([pub.id, wedding.id]);
        assert.strictEqual(fromBoth.length, 2);

        await library.deletePlaylist(wedding.id);
        const leftover = await library.loadLibrary();
        assert.strictEqual(leftover.playlists.length, 1);
        assert.strictEqual(leftover.questions.length, 2);

        const imported = await library.importCsv(
            'id,question,answers,aliases_json\n1,Capital of France?,Paris|{}\n2,A new import?,Yes | No|{}\n',
            { playlistName: 'CSV dump' }
        );
        assert.strictEqual(imported.added, 1);
        assert.strictEqual(imported.skipped, 1);
        assert.strictEqual(imported.playlist.name, 'CSV dump');
        assert.strictEqual(imported.playlist.questionIds.length, 2);
        console.log('library.test.js ok');
    } finally {
        try { fs.unlinkSync(FILE); } catch (_) {}
    }
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
