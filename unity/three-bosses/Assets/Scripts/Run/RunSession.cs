using System;

namespace ThreeBosses.Run
{
    public enum RunPhase
    {
        NotStarted,
        Countdown,
        Running,
        Transitioning,
        Defeated,
        Completed
    }

    public enum BossId
    {
        None = 0,
        Bee = 1,
        Cyborg = 2,
        Kraken = 3
    }

    public enum BossDefeatResult
    {
        Rejected,
        AdvanceToNextBoss,
        RunCompleted
    }

    public interface IMonotonicClock
    {
        double NowSeconds { get; }
    }

    public sealed class RunSession
    {
        private const int BossCount = 3;

        private readonly IMonotonicClock clock;
        private readonly double[] bossSplitSeconds = new double[BossCount];

        private double activeCombatStartedAtSeconds;
        private double accumulatedCombatSeconds;
        private double finalElapsedSeconds;
        private bool hasResult;

        public RunSession(IMonotonicClock clock)
        {
            this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        }

        public Guid RunId { get; private set; }
        public RunPhase Phase { get; private set; } = RunPhase.NotStarted;
        public BossId CurrentBoss { get; private set; } = BossId.None;
        public BossId PendingBoss { get; private set; } = BossId.None;
        public int BossesDefeated { get; private set; }
        public bool IsPracticeRun { get; private set; }
        public int Score { get; private set; }
        public string Rank { get; private set; } = string.Empty;
        public bool Submitted { get; private set; }
        public bool HasResult => hasResult;
        public bool IsEligibleForSubmission =>
            !IsPracticeRun && Phase == RunPhase.Completed && BossesDefeated == BossCount;

        public double ElapsedSeconds
        {
            get
            {
                if (Phase == RunPhase.Running)
                {
                    double activeCombatSeconds = Math.Max(
                        0d,
                        clock.NowSeconds - activeCombatStartedAtSeconds);
                    return accumulatedCombatSeconds + activeCombatSeconds;
                }

                if (Phase == RunPhase.Transitioning)
                    return accumulatedCombatSeconds;

                if (Phase == RunPhase.Defeated || Phase == RunPhase.Completed)
                    return finalElapsedSeconds;

                return 0d;
            }
        }

        public void BeginNewRun()
        {
            ResetMutableState();
            RunId = Guid.NewGuid();
            CurrentBoss = BossId.Bee;
            Phase = RunPhase.Countdown;
        }

        public bool StartRun()
        {
            if (Phase != RunPhase.Countdown)
                return false;

            activeCombatStartedAtSeconds = clock.NowSeconds;
            Phase = RunPhase.Running;
            return true;
        }

        public void BeginPractice(BossId boss)
        {
            if (!IsBoss(boss))
                throw new ArgumentOutOfRangeException(nameof(boss));

            ResetMutableState();
            RunId = Guid.NewGuid();
            CurrentBoss = boss;
            PendingBoss = BossId.None;
            BossesDefeated = (int)boss - 1;
            IsPracticeRun = true;
            activeCombatStartedAtSeconds = clock.NowSeconds;
            Phase = RunPhase.Running;
        }

        public BossDefeatResult RecordBossDefeat(BossId boss)
        {
            if (Phase != RunPhase.Running || boss != CurrentBoss)
                return BossDefeatResult.Rejected;

            double elapsed = ElapsedSeconds;
            accumulatedCombatSeconds = elapsed;
            bossSplitSeconds[(int)boss - 1] = elapsed;
            BossesDefeated++;

            if (boss == BossId.Kraken)
            {
                finalElapsedSeconds = elapsed;
                CurrentBoss = BossId.None;
                PendingBoss = BossId.None;
                Phase = RunPhase.Completed;
                return BossDefeatResult.RunCompleted;
            }

            PendingBoss = (BossId)((int)boss + 1);
            Phase = RunPhase.Transitioning;
            return BossDefeatResult.AdvanceToNextBoss;
        }

        public bool EnterNextBoss(BossId boss)
        {
            if (Phase != RunPhase.Transitioning || boss != PendingBoss)
                return false;

            CurrentBoss = boss;
            PendingBoss = BossId.None;
            activeCombatStartedAtSeconds = clock.NowSeconds;
            Phase = RunPhase.Running;
            return true;
        }

        public bool RecordDeath()
        {
            if (Phase != RunPhase.Running)
                return false;

            finalElapsedSeconds = ElapsedSeconds;
            Phase = RunPhase.Defeated;
            return true;
        }

        public bool TrySetResult(int score, string rank)
        {
            if (Phase != RunPhase.Completed || hasResult || score < 0 || string.IsNullOrWhiteSpace(rank))
                return false;

            Score = score;
            Rank = rank;
            hasResult = true;
            return true;
        }

        public bool MarkSubmitted()
        {
            if (!IsEligibleForSubmission || !hasResult || Submitted)
                return false;

            Submitted = true;
            return true;
        }

        public double GetBossSplitSeconds(BossId boss)
        {
            if (!IsBoss(boss))
                throw new ArgumentOutOfRangeException(nameof(boss));

            return bossSplitSeconds[(int)boss - 1];
        }

        public RunSessionSnapshot CreateSnapshot()
        {
            return new RunSessionSnapshot(
                RunId,
                Phase,
                CurrentBoss,
                PendingBoss,
                BossesDefeated,
                ElapsedSeconds,
                bossSplitSeconds,
                IsPracticeRun,
                hasResult,
                Score,
                Rank,
                Submitted);
        }

        private void ResetMutableState()
        {
            Array.Clear(bossSplitSeconds, 0, bossSplitSeconds.Length);
            activeCombatStartedAtSeconds = 0d;
            accumulatedCombatSeconds = 0d;
            finalElapsedSeconds = 0d;
            RunId = Guid.Empty;
            Phase = RunPhase.NotStarted;
            CurrentBoss = BossId.None;
            PendingBoss = BossId.None;
            BossesDefeated = 0;
            IsPracticeRun = false;
            hasResult = false;
            Score = 0;
            Rank = string.Empty;
            Submitted = false;
        }

        private static bool IsBoss(BossId boss)
        {
            return boss >= BossId.Bee && boss <= BossId.Kraken;
        }
    }

    public sealed class RunSessionSnapshot
    {
        private readonly double[] bossSplitSeconds;

        public RunSessionSnapshot(
            Guid runId,
            RunPhase phase,
            BossId currentBoss,
            BossId pendingBoss,
            int bossesDefeated,
            double elapsedSeconds,
            double[] bossSplitSeconds,
            bool isPracticeRun,
            bool hasResult,
            int score,
            string rank,
            bool submitted)
        {
            RunId = runId;
            Phase = phase;
            CurrentBoss = currentBoss;
            PendingBoss = pendingBoss;
            BossesDefeated = bossesDefeated;
            ElapsedSeconds = elapsedSeconds;
            this.bossSplitSeconds = (double[])bossSplitSeconds.Clone();
            IsPracticeRun = isPracticeRun;
            HasResult = hasResult;
            Score = score;
            Rank = rank;
            Submitted = submitted;
        }

        public Guid RunId { get; }
        public RunPhase Phase { get; }
        public BossId CurrentBoss { get; }
        public BossId PendingBoss { get; }
        public int BossesDefeated { get; }
        public double ElapsedSeconds { get; }
        public bool IsPracticeRun { get; }
        public bool HasResult { get; }
        public int Score { get; }
        public string Rank { get; }
        public bool Submitted { get; }

        public double GetBossSplitSeconds(BossId boss)
        {
            if (boss < BossId.Bee || boss > BossId.Kraken)
                throw new ArgumentOutOfRangeException(nameof(boss));

            return bossSplitSeconds[(int)boss - 1];
        }
    }
}
