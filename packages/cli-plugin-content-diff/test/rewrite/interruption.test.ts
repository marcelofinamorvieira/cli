import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'mocha';
import { withInterruptHandling } from '../../src/utils/interruption';

describe('one-shot command interruption', () => {
  it('removes only its own signal handlers after success and failure', async () => {
    const before = ['SIGHUP', 'SIGINT', 'SIGTERM'].map((name) =>
      process.listenerCount(name),
    );
    assert.equal(
      await withInterruptHandling(async () => 'complete'),
      'complete',
    );
    await assert.rejects(
      withInterruptHandling(async () => {
        throw new Error('failure');
      }),
      /failure/,
    );
    assert.deepEqual(
      ['SIGHUP', 'SIGINT', 'SIGTERM'].map((name) =>
        process.listenerCount(name),
      ),
      before,
    );
  });

  const exitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
    it(`waits for owned cleanup before exiting on ${signal}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'content-interruption-'));
      const marker = join(directory, 'cleanup.json');
      const helper = resolve(__dirname, '../../src/utils/interruption.ts');
      const cancellation = resolve(
        __dirname,
        '../../src/engine/cancellation.ts',
      );
      const script = `
        const { writeFile } = require('node:fs/promises');
        const { withInterruptHandling } = require(${JSON.stringify(helper)});
        const { assertNotAborted } = require(${JSON.stringify(cancellation)});
        withInterruptHandling(async (signal) => {
          try {
            await new Promise((resolve) => {
              const activeRequest = setInterval(() => {}, 1000);
              signal.addEventListener('abort', () => {
                clearInterval(activeRequest);
                resolve();
              }, { once: true });
              process.stdout.write('ready\\n');
            });
            assertNotAborted(signal);
          } finally {
            await new Promise(resolve => setTimeout(resolve, 30));
            await writeFile(${JSON.stringify(marker)}, JSON.stringify({ cleaned: true }));
          }
        }, () => { throw new Error('reporter failed'); }).catch(error => {
          process.stdout.write(error.code + '\\n');
          require('@oclif/core/handle').handle(error);
        });
      `;
      const child = spawn(
        process.execPath,
        ['--require', 'ts-node/register/transpile-only', '-e', script],
        {
          cwd: resolve(__dirname, '../..'),
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      let errors = '';
      let sent = false;
      child.stdout.on('data', (data: Buffer) => {
        output += data.toString();
        if (!sent && output.includes('ready\n')) {
          sent = true;
          child.kill(signal);
        }
      });
      child.stderr.on('data', (data: Buffer) => {
        errors += data.toString();
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      try {
        const result = await new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code, exitSignal) =>
            resolve({ code, signal: exitSignal }),
          );
        });
        assert.equal(result.signal, null, errors);
        assert.equal(result.code, exitCodes[signal], errors);
        assert.match(output, /INTERRUPTED/);
        assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), {
          cleaned: true,
        });
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  it('reports repeated signals and survives output errors after a hangup during cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'content-interruption-'));
    const marker = join(directory, 'cleanup.json');
    const helper = resolve(__dirname, '../../src/utils/interruption.ts');
    const cancellation = resolve(__dirname, '../../src/engine/cancellation.ts');
    const script = `
      const { writeFile } = require('node:fs/promises');
      // Installs oclif's stdout handler, which rethrows everything but EPIPE.
      require('@oclif/core');
      const { withInterruptHandling } = require(${JSON.stringify(helper)});
      const { assertNotAborted } = require(${JSON.stringify(cancellation)});
      withInterruptHandling(async (signal) => {
        try {
          await new Promise((resolve) => {
            const activeRequest = setInterval(() => {}, 1000);
            signal.addEventListener('abort', () => {
              clearInterval(activeRequest);
              resolve();
            }, { once: true });
            process.stdout.write('ready\\n');
          });
          assertNotAborted(signal);
        } finally {
          process.stdout.write('cleaning\\n');
          await new Promise((resolve) => process.stdin.once('end', resolve).resume());
          // A closed terminal reports every later write as an error event.
          for (const stream of [process.stdout, process.stderr])
            stream.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO' }));
          await writeFile(${JSON.stringify(marker)}, JSON.stringify({ cleaned: true }));
        }
      }).catch(error => {
        process.stdout.write(error.code + '\\n');
        require('@oclif/core/handle').handle(error);
      });
    `;
    const child = spawn(
      process.execPath,
      ['--require', 'ts-node/register/transpile-only', '-e', script],
      {
        cwd: resolve(__dirname, '../..'),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const repeated = /Cleanup is still in progress/g;
    let output = '';
    let errors = '';
    let step = 0;
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
      if (step === 0 && output.includes('ready\n')) {
        step = 1;
        child.kill('SIGINT');
      } else if (step === 1 && output.includes('cleaning\n')) {
        step = 2;
        child.kill('SIGINT');
      }
    });
    child.stderr.on('data', (data: Buffer) => {
      errors += data.toString();
      const reported = errors.match(repeated)?.length ?? 0;
      if (step === 2 && reported === 1) {
        step = 3;
        child.kill('SIGHUP');
      } else if (step === 3 && reported === 2) {
        step = 4;
        child.stdin.end();
      }
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try {
      const result = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, exitSignal) =>
          resolve({ code, signal: exitSignal }),
        );
      });
      assert.equal(result.signal, null, errors);
      assert.equal(result.code, 130, errors);
      assert.equal(errors.match(repeated)?.length, 2, errors);
      assert.match(output, /INTERRUPTED/);
      assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), {
        cleaned: true,
      });
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  });
});
