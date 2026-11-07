import { assertChildSchemaCleanSource, childSchemaCommandSettings, createChildSchemaConnection } from '../migrations/runChildSignedFormSchema';
import { observeSignedParentFormRetention, parseSignedParentFormRetentionInput,
    SIGNED_FORM_RETENTION_FAILURE, type SignedParentFormRetentionDependencies } from './signedParentFormRetention';

type Environment = Readonly<Record<string, string | undefined>>;
type Input = AsyncIterable<Uint8Array | string>;
type CommandDependencies = Readonly<{
    settings?: typeof childSchemaCommandSettings;
    assertSource?: typeof assertChildSchemaCleanSource;
    connect?: typeof createChildSchemaConnection;
    observe?: typeof observeSignedParentFormRetention;
    input?: Input;
    write?: (value: string) => void;
}>;

export async function readSignedParentFormRetentionInput(input: Input): Promise<readonly string[]> {
    try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of input) {
            const buffer = Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > 8192) throw new Error(SIGNED_FORM_RETENTION_FAILURE);
            chunks.push(buffer);
        }
        return parseSignedParentFormRetentionInput(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    }
    catch { throw new Error(SIGNED_FORM_RETENTION_FAILURE); }
}

/** No target override, file argument, mutation mode or output path is supported. */
export async function runSignedParentFormRetention(args = process.argv.slice(2), env: Environment = process.env,
    dependencies: CommandDependencies = {}): Promise<void> {
    if (args.length !== 0) throw new Error(SIGNED_FORM_RETENTION_FAILURE);
    const references = await readSignedParentFormRetentionInput(dependencies.input ?? process.stdin);
    let session: ReturnType<typeof createChildSchemaConnection> | undefined;
    try {
        const loaded = (dependencies.settings ?? childSchemaCommandSettings)(env);
        const assertSource = () => (dependencies.assertSource ?? assertChildSchemaCleanSource)(loaded.source.sourceCommit, undefined, env);
        assertSource();
        session = (dependencies.connect ?? createChildSchemaConnection)(loaded.config);
        const reportDeps: SignedParentFormRetentionDependencies = { connection: session.connection,
            settings: loaded.settings, source: loaded.source, assertSource };
        const report = await (dependencies.observe ?? observeSignedParentFormRetention)(reportDeps, references);
        // A close failure also withholds stdout; this command never emits a partial batch.
        const completedSession = session; session = undefined;
        await completedSession.close();
        (dependencies.write ?? (value => { process.stdout.write(value); }))(`${JSON.stringify(report, null, 2)}\n`);
    } catch { throw new Error(SIGNED_FORM_RETENTION_FAILURE); }
    finally {
        if (session) {
            try { await session.close(); } catch { throw new Error(SIGNED_FORM_RETENTION_FAILURE); }
        }
    }
}

if (require.main === module) runSignedParentFormRetention().catch(() => {
    console.error(SIGNED_FORM_RETENTION_FAILURE);
    process.exitCode = 1;
});
