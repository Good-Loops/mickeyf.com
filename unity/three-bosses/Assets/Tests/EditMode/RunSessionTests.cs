using System;
using NUnit.Framework;

namespace ThreeBosses.Run.Tests
{
    public sealed class RunSessionTests
    {
        private FakeClock clock;
        private RunSession session;

        [SetUp]
        public void SetUp()
        {
            clock = new FakeClock();
            session = new RunSession(clock);
        }

        [Test]
        public void CountdownIsExcludedAndTimerStartsAtGo()
        {
            session.BeginNewRun();
            clock.Advance(3d);

            Assert.That(session.ElapsedSeconds, Is.Zero);
            Assert.That(session.StartRun(), Is.True);

            clock.Advance(1.25d);
            Assert.That(session.ElapsedSeconds, Is.EqualTo(1.25d).Within(0.0001d));
        }

        [Test]
        public void BeginNewRunRaisesOneEventWithTheAssignedRunId()
        {
            int eventCount = 0;
            Guid signaledRunId = Guid.Empty;
            session.NormalRunStarted += runId =>
            {
                eventCount++;
                signaledRunId = runId;
            };

            session.BeginNewRun();

            Assert.That(eventCount, Is.EqualTo(1));
            Assert.That(signaledRunId, Is.Not.EqualTo(Guid.Empty));
            Assert.That(signaledRunId, Is.EqualTo(session.RunId));
        }

        [Test]
        public void BeginPracticeDoesNotRaiseNormalRunStarted()
        {
            int eventCount = 0;
            session.NormalRunStarted += _ => eventCount++;

            session.BeginPractice(BossId.Bee);

            Assert.That(eventCount, Is.Zero);
        }

        [Test]
        public void StartRunCanOnlySucceedOnce()
        {
            session.BeginNewRun();

            Assert.That(session.StartRun(), Is.True);
            clock.Advance(2d);
            Assert.That(session.StartRun(), Is.False);
            Assert.That(session.ElapsedSeconds, Is.EqualTo(2d).Within(0.0001d));
        }

        [Test]
        public void PausableClockFreezesNowAndExcludesThePausedGapAfterResume()
        {
            var pausableClock = new PausableMonotonicClock(clock);
            clock.Advance(10d);

            Assert.That(pausableClock.NowSeconds, Is.EqualTo(10d).Within(0.0001d));
            Assert.That(pausableClock.Pause(), Is.True);

            clock.Advance(12d);
            Assert.That(pausableClock.NowSeconds, Is.EqualTo(10d).Within(0.0001d));
            Assert.That(pausableClock.Resume(), Is.True);

            clock.Advance(3d);
            Assert.That(pausableClock.NowSeconds, Is.EqualTo(13d).Within(0.0001d));
        }

        [Test]
        public void PausableClockPauseAndResumeAreIdempotentAcrossMultipleCycles()
        {
            var pausableClock = new PausableMonotonicClock(clock);
            clock.Advance(2d);

            Assert.That(pausableClock.Pause(), Is.True);
            clock.Advance(5d);
            Assert.That(pausableClock.Pause(), Is.False);
            clock.Advance(3d);
            Assert.That(pausableClock.Resume(), Is.True);
            Assert.That(pausableClock.Resume(), Is.False);

            clock.Advance(4d);
            Assert.That(pausableClock.Pause(), Is.True);
            clock.Advance(6d);
            Assert.That(pausableClock.Resume(), Is.True);
            clock.Advance(1d);

            Assert.That(pausableClock.NowSeconds, Is.EqualTo(7d).Within(0.0001d));
        }

        [Test]
        public void RunStartedWhileClockIsPausedRemainsAtZeroUntilResume()
        {
            var pausableClock = new PausableMonotonicClock(clock);
            var pausedSession = new RunSession(pausableClock);

            pausedSession.BeginNewRun();
            Assert.That(pausableClock.Pause(), Is.True);
            clock.Advance(10d);
            Assert.That(pausedSession.StartRun(), Is.True);
            clock.Advance(5d);

            Assert.That(pausedSession.ElapsedSeconds, Is.Zero.Within(0.0001d));
            Assert.That(pausableClock.Resume(), Is.True);
            clock.Advance(2d);
            Assert.That(pausedSession.ElapsedSeconds, Is.EqualTo(2d).Within(0.0001d));
        }

        [Test]
        public void NextBossEnteredWhileClockIsPausedDoesNotAccrueHiddenTime()
        {
            var pausableClock = new PausableMonotonicClock(clock);
            var pausedSession = new RunSession(pausableClock);

            pausedSession.BeginNewRun();
            Assert.That(pausedSession.StartRun(), Is.True);
            clock.Advance(3d);
            Assert.That(
                pausedSession.RecordBossDefeat(BossId.Bee),
                Is.EqualTo(BossDefeatResult.AdvanceToNextBoss));

            Assert.That(pausableClock.Pause(), Is.True);
            clock.Advance(10d);
            Assert.That(pausedSession.EnterNextBoss(BossId.Cyborg), Is.True);
            clock.Advance(5d);
            Assert.That(pausedSession.ElapsedSeconds, Is.EqualTo(3d).Within(0.0001d));

            Assert.That(pausableClock.Resume(), Is.True);
            clock.Advance(2d);
            Assert.That(pausedSession.ElapsedSeconds, Is.EqualTo(5d).Within(0.0001d));
        }

        [Test]
        public void TimerExcludesBossDeathAndTransitionTime()
        {
            StartRun();
            clock.Advance(10d);

            Assert.That(
                session.RecordBossDefeat(BossId.Bee),
                Is.EqualTo(BossDefeatResult.AdvanceToNextBoss));

            clock.Advance(5d);
            Assert.That(session.ElapsedSeconds, Is.EqualTo(10d).Within(0.0001d));
            Assert.That(session.GetBossSplitSeconds(BossId.Bee), Is.EqualTo(10d).Within(0.0001d));
            Assert.That(session.Phase, Is.EqualTo(RunPhase.Transitioning));
            Assert.That(session.CurrentBoss, Is.EqualTo(BossId.Bee));
            Assert.That(session.PendingBoss, Is.EqualTo(BossId.Cyborg));
            Assert.That(session.EnterNextBoss(BossId.Cyborg), Is.True);
            Assert.That(session.CurrentBoss, Is.EqualTo(BossId.Cyborg));

            clock.Advance(2d);
            Assert.That(session.ElapsedSeconds, Is.EqualTo(12d).Within(0.0001d));
        }

        [Test]
        public void DeathIsIgnoredDuringBossTransition()
        {
            StartRun();
            clock.Advance(6d);

            Assert.That(session.RecordBossDefeat(BossId.Bee), Is.EqualTo(BossDefeatResult.AdvanceToNextBoss));
            clock.Advance(2d);

            Assert.That(session.RecordDeath(), Is.False);
            Assert.That(session.Phase, Is.EqualTo(RunPhase.Transitioning));
            Assert.That(session.ElapsedSeconds, Is.EqualTo(6d).Within(0.0001d));
            Assert.That(session.EnterNextBoss(BossId.Kraken), Is.False);
            Assert.That(session.EnterNextBoss(BossId.Cyborg), Is.True);
        }

        [Test]
        public void DuplicateOrOutOfOrderBossEventsAreIgnored()
        {
            StartRun();
            clock.Advance(4d);

            Assert.That(session.RecordBossDefeat(BossId.Bee), Is.Not.EqualTo(BossDefeatResult.Rejected));
            Assert.That(session.RecordBossDefeat(BossId.Bee), Is.EqualTo(BossDefeatResult.Rejected));
            Assert.That(session.RecordBossDefeat(BossId.Kraken), Is.EqualTo(BossDefeatResult.Rejected));
            Assert.That(session.BossesDefeated, Is.EqualTo(1));
        }

        [Test]
        public void DeathFreezesTimeAndRejectsLaterCompletion()
        {
            StartRun();
            clock.Advance(12.5d);

            Assert.That(session.RecordDeath(), Is.True);
            clock.Advance(20d);

            Assert.That(session.ElapsedSeconds, Is.EqualTo(12.5d).Within(0.0001d));
            Assert.That(session.RecordDeath(), Is.False);
            Assert.That(session.RecordBossDefeat(BossId.Bee), Is.EqualTo(BossDefeatResult.Rejected));
            Assert.That(session.Phase, Is.EqualTo(RunPhase.Defeated));
        }

        [Test]
        public void FinalBossCompletionFreezesTimeAndAcceptsOneResult()
        {
            StartRun();
            DefeatCurrentBossAfter(10d, BossId.Bee, 5d);
            DefeatCurrentBossAfter(20d, BossId.Cyborg, 7d);

            clock.Advance(30d);
            Assert.That(
                session.RecordBossDefeat(BossId.Kraken),
                Is.EqualTo(BossDefeatResult.RunCompleted));

            int score = RunScoreCalculator.Calculate(session.ElapsedSeconds);
            Assert.That(session.TrySetResult(score, "UNRANKED"), Is.True);
            Assert.That(session.TrySetResult(score + 1, "OTHER"), Is.False);

            clock.Advance(100d);
            Assert.That(session.ElapsedSeconds, Is.EqualTo(60d).Within(0.0001d));
            Assert.That(session.Score, Is.EqualTo(166667));
            Assert.That(session.Rank, Is.EqualTo("UNRANKED"));
        }

        [Test]
        public void CompletionAndDeathUseFirstTerminalEvent()
        {
            session.BeginPractice(BossId.Kraken);
            clock.Advance(7d);

            Assert.That(session.RecordBossDefeat(BossId.Kraken), Is.EqualTo(BossDefeatResult.RunCompleted));
            Assert.That(session.RecordDeath(), Is.False);
            Assert.That(session.Phase, Is.EqualTo(RunPhase.Completed));
        }

        [Test]
        public void PracticeRunCannotBeSubmitted()
        {
            session.BeginPractice(BossId.Kraken);
            clock.Advance(10d);

            Assert.That(session.RecordBossDefeat(BossId.Kraken), Is.EqualTo(BossDefeatResult.RunCompleted));
            Assert.That(session.TrySetResult(RunScoreCalculator.Calculate(session.ElapsedSeconds), "UNRANKED"), Is.True);
            Assert.That(session.IsEligibleForSubmission, Is.False);
            Assert.That(session.MarkSubmitted(), Is.False);
        }

        [Test]
        public void EligibleCompletedRunCanOnlyBeMarkedSubmittedOnce()
        {
            StartRun();
            DefeatCurrentBossAfter(10d, BossId.Bee);
            DefeatCurrentBossAfter(10d, BossId.Cyborg);
            clock.Advance(10d);

            Assert.That(session.RecordBossDefeat(BossId.Kraken), Is.EqualTo(BossDefeatResult.RunCompleted));
            Assert.That(session.MarkSubmitted(), Is.False, "A result must exist before submission succeeds.");
            Assert.That(session.TrySetResult(RunScoreCalculator.Calculate(session.ElapsedSeconds), "UNRANKED"), Is.True);
            Assert.That(session.IsEligibleForSubmission, Is.True);
            Assert.That(session.MarkSubmitted(), Is.True);
            Assert.That(session.MarkSubmitted(), Is.False);
        }

        [Test]
        public void SnapshotKeepsItsOwnBossSplitsAfterSessionChanges()
        {
            StartRun();
            clock.Advance(8d);
            Assert.That(session.RecordBossDefeat(BossId.Bee), Is.EqualTo(BossDefeatResult.AdvanceToNextBoss));

            RunSessionSnapshot snapshot = session.CreateSnapshot();
            Assert.That(snapshot.GetBossSplitSeconds(BossId.Bee), Is.EqualTo(8d).Within(0.0001d));

            clock.Advance(25d);
            Assert.That(session.ElapsedSeconds, Is.EqualTo(8d).Within(0.0001d));
            Assert.That(snapshot.ElapsedSeconds, Is.EqualTo(8d).Within(0.0001d));

            session.BeginNewRun();
            Assert.That(session.GetBossSplitSeconds(BossId.Bee), Is.Zero);
            Assert.That(snapshot.GetBossSplitSeconds(BossId.Bee), Is.EqualTo(8d).Within(0.0001d));
            Assert.That(snapshot.Phase, Is.EqualTo(RunPhase.Transitioning));
        }

        [Test]
        public void NewRunClearsPriorTerminalState()
        {
            StartRun();
            clock.Advance(9d);
            session.RecordDeath();

            session.BeginNewRun();

            Assert.That(session.Phase, Is.EqualTo(RunPhase.Countdown));
            Assert.That(session.CurrentBoss, Is.EqualTo(BossId.Bee));
            Assert.That(session.BossesDefeated, Is.Zero);
            Assert.That(session.ElapsedSeconds, Is.Zero);
            Assert.That(session.HasResult, Is.False);
            Assert.That(session.Submitted, Is.False);
        }

        [TestCase(100d, 100000)]
        [TestCase(60d, 166667)]
        [TestCase(40d, 250000)]
        public void ScoreFormulaIsDeterministic(double seconds, int expected)
        {
            Assert.That(RunScoreCalculator.Calculate(seconds), Is.EqualTo(expected));
        }

        [Test]
        public void ScoreAndRankShareTheMinimumCompletionTimeBoundary()
        {
            const int belowMinimumMilliseconds =
                RunScoreCalculator.MinimumCompletionTimeMilliseconds - 1;

            Assert.Throws<ArgumentOutOfRangeException>(
                () => RunScoreCalculator.CalculateFromMilliseconds(belowMinimumMilliseconds));
            Assert.Throws<ArgumentOutOfRangeException>(
                () => RunRankCalculator.CalculateFromMilliseconds(belowMinimumMilliseconds));
            Assert.That(
                RunScoreCalculator.CalculateFromMilliseconds(
                    RunScoreCalculator.MinimumCompletionTimeMilliseconds),
                Is.EqualTo(1000000));
            Assert.That(
                RunRankCalculator.CalculateFromMilliseconds(
                    RunScoreCalculator.MinimumCompletionTimeMilliseconds),
                Is.EqualTo("S"));
        }

        [TestCase(59.999d, "S")]
        [TestCase(60d, "A")]
        [TestCase(80d, "A")]
        [TestCase(80.001d, "B")]
        [TestCase(100d, "B")]
        [TestCase(100.001d, "C")]
        [TestCase(120d, "C")]
        [TestCase(120.001d, "D")]
        public void RankFormulaUsesApprovedTimeBands(double seconds, string expected)
        {
            Assert.That(RunRankCalculator.Calculate(seconds), Is.EqualTo(expected));
        }

        [TestCase(59.9994d, 59999, "S")]
        [TestCase(59.9995d, 60000, "A")]
        [TestCase(80.0004d, 80000, "A")]
        [TestCase(80.0005d, 80001, "B")]
        public void CanonicalMillisecondsOwnScoreAndRankBoundaries(
            double seconds,
            int expectedMilliseconds,
            string expectedRank)
        {
            int milliseconds = RunScoreCalculator.CanonicalizeCompletionTimeMilliseconds(seconds);
            Assert.That(milliseconds, Is.EqualTo(expectedMilliseconds));
            Assert.That(
                RunScoreCalculator.CalculateFromMilliseconds(milliseconds),
                Is.EqualTo((int)Math.Round(
                    (double)RunScoreCalculator.ScoreNumerator / milliseconds,
                    MidpointRounding.AwayFromZero)));
            Assert.That(
                RunRankCalculator.CalculateFromMilliseconds(milliseconds),
                Is.EqualTo(expectedRank));
        }

        [Test]
        public void SubmissionCoordinatorAcceptsOnlyTheCanonicalServerResult()
        {
            CompleteRunAndSetResult(82d);
            var coordinator = new RunSubmissionCoordinator(session);
            coordinator.ConfigureTransport(true);

            Assert.That(coordinator.Status, Is.EqualTo(RunSubmissionStatus.Ready));
            Assert.That(coordinator.TryBegin(out RunSubmissionPayload payload), Is.True);
            Assert.That(payload.RunId, Is.EqualTo(session.RunId.ToString("D")));
            Assert.That(payload.CompletionTimeMilliseconds, Is.EqualTo(82000));
            Assert.That(coordinator.Status, Is.EqualTo(RunSubmissionStatus.Submitting));

            Assert.That(
                coordinator.CompleteSuccess(payload.RunId, 82000, 121951, "B"),
                Is.True);
            Assert.That(session.Submitted, Is.True);
            Assert.That(coordinator.Status, Is.EqualTo(RunSubmissionStatus.Submitted));
        }

        [Test]
        public void SubmissionCoordinatorAllowsExactRetryAfterAuthorizationFailure()
        {
            CompleteRunAndSetResult(82d);
            var coordinator = new RunSubmissionCoordinator(session);
            coordinator.ConfigureTransport(true);
            Assert.That(coordinator.TryBegin(out RunSubmissionPayload firstPayload), Is.True);

            coordinator.CompleteFailure(firstPayload.RunId, "UNAUTHORIZED");
            Assert.That(coordinator.Status, Is.EqualTo(RunSubmissionStatus.SignInRequired));
            Assert.That(coordinator.TryBegin(out RunSubmissionPayload retryPayload), Is.True);
            Assert.That(retryPayload.RunId, Is.EqualTo(firstPayload.RunId));
            Assert.That(retryPayload.CompletionTimeMilliseconds, Is.EqualTo(82000));
        }

        [Test]
        public void SubmissionCoordinatorRequiresANewRunWhenStartTicketWasUnavailable()
        {
            CompleteRunAndSetResult(82d);
            var coordinator = new RunSubmissionCoordinator(session);
            coordinator.ConfigureTransport(true);
            Assert.That(coordinator.TryBegin(out RunSubmissionPayload payload), Is.True);

            coordinator.CompleteFailure(
                payload.RunId,
                RunSubmissionCoordinator.RunTicketUnavailableErrorCode);

            Assert.That(coordinator.Status, Is.EqualTo(RunSubmissionStatus.Rejected));
            Assert.That(
                coordinator.LastErrorCode,
                Is.EqualTo(RunSubmissionCoordinator.RunTicketUnavailableErrorCode));
            Assert.That(coordinator.RequiresNewRun, Is.True);
            Assert.That(coordinator.TryBegin(out _), Is.False);
        }

        [Test]
        public void SubmissionCoordinatorRejectsMismatchedServerResult()
        {
            CompleteRunAndSetResult(82d);
            var coordinator = new RunSubmissionCoordinator(session);
            coordinator.ConfigureTransport(true);
            Assert.That(coordinator.TryBegin(out RunSubmissionPayload payload), Is.True);

            Assert.That(
                coordinator.CompleteSuccess(payload.RunId, 82001, 121951, "B"),
                Is.False);
            Assert.That(session.Submitted, Is.False);
            Assert.That(coordinator.Status, Is.EqualTo(RunSubmissionStatus.Rejected));
            Assert.That(coordinator.LastErrorCode, Is.EqualTo("INVALID_RESPONSE"));
        }

        [TestCase(0d)]
        [TestCase(-1d)]
        [TestCase(double.NaN)]
        [TestCase(double.PositiveInfinity)]
        public void ScoreRejectsInvalidTimes(double seconds)
        {
            Assert.Throws<ArgumentOutOfRangeException>(() => RunScoreCalculator.Calculate(seconds));
            Assert.Throws<ArgumentOutOfRangeException>(() => RunRankCalculator.Calculate(seconds));
        }

        private void StartRun()
        {
            session.BeginNewRun();
            Assert.That(session.StartRun(), Is.True);
        }

        private void CompleteRunAndSetResult(double totalSeconds)
        {
            StartRun();
            DefeatCurrentBossAfter(totalSeconds / 4d, BossId.Bee);
            DefeatCurrentBossAfter(totalSeconds / 4d, BossId.Cyborg);
            clock.Advance(totalSeconds / 2d);
            Assert.That(
                session.RecordBossDefeat(BossId.Kraken),
                Is.EqualTo(BossDefeatResult.RunCompleted));

            int completionTimeMilliseconds =
                RunScoreCalculator.CanonicalizeCompletionTimeMilliseconds(session.ElapsedSeconds);
            Assert.That(
                session.TrySetResult(
                    RunScoreCalculator.CalculateFromMilliseconds(completionTimeMilliseconds),
                    RunRankCalculator.CalculateFromMilliseconds(completionTimeMilliseconds)),
                Is.True);
        }

        private void DefeatCurrentBossAfter(
            double activeCombatSeconds,
            BossId boss,
            double transitionSeconds = 0d)
        {
            clock.Advance(activeCombatSeconds);
            Assert.That(session.RecordBossDefeat(boss), Is.EqualTo(BossDefeatResult.AdvanceToNextBoss));

            double elapsedAtDefeat = session.ElapsedSeconds;
            clock.Advance(transitionSeconds);
            Assert.That(session.ElapsedSeconds, Is.EqualTo(elapsedAtDefeat).Within(0.0001d));

            Assert.That(session.EnterNextBoss((BossId)((int)boss + 1)), Is.True);
        }

        private sealed class FakeClock : IMonotonicClock
        {
            public double NowSeconds { get; private set; }

            public void Advance(double seconds)
            {
                NowSeconds += seconds;
            }
        }
    }
}
