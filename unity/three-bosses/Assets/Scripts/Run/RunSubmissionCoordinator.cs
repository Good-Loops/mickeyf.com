using System;

namespace ThreeBosses.Run
{
    public enum RunSubmissionStatus
    {
        Locked,
        Ready,
        Submitting,
        Submitted,
        SignInRequired,
        RetryableFailure,
        Rejected
    }

    public readonly struct RunSubmissionPayload
    {
        public RunSubmissionPayload(string runId, int completionTimeMilliseconds)
        {
            RunId = runId;
            CompletionTimeMilliseconds = completionTimeMilliseconds;
        }

        public string RunId { get; }
        public int CompletionTimeMilliseconds { get; }
    }

    /// <summary>
    /// Owns the platform-neutral submission state for the active run. The
    /// browser bridge and Unity UI are adapters around this state machine.
    /// </summary>
    public sealed class RunSubmissionCoordinator
    {
        public const string RunTicketUnavailableErrorCode = "RUN_TICKET_UNAVAILABLE";

        private readonly RunSession session;

        private Guid trackedRunId;
        private int trackedCompletionTimeMilliseconds;
        private bool transportEnabled;
        private RunSubmissionStatus status = RunSubmissionStatus.Locked;
        private string lastErrorCode = string.Empty;

        public RunSubmissionCoordinator(RunSession session)
        {
            this.session = session ?? throw new ArgumentNullException(nameof(session));
            trackedRunId = session.RunId;
        }

        public event Action Changed;

        public RunSubmissionStatus Status => status;
        public string LastErrorCode => lastErrorCode;
        public bool TransportEnabled => transportEnabled;
        public bool RequiresNewRun =>
            status == RunSubmissionStatus.Rejected &&
            string.Equals(
                lastErrorCode,
                RunTicketUnavailableErrorCode,
                StringComparison.Ordinal);

        public void ConfigureTransport(bool enabled)
        {
            if (transportEnabled == enabled)
            {
                Refresh();
                return;
            }

            transportEnabled = enabled;
            if (!enabled && status != RunSubmissionStatus.Submitted)
                SetState(RunSubmissionStatus.Locked, string.Empty);

            Refresh();
        }

        public void Refresh()
        {
            if (trackedRunId != session.RunId)
            {
                trackedRunId = session.RunId;
                trackedCompletionTimeMilliseconds = 0;
                lastErrorCode = string.Empty;
                status = RunSubmissionStatus.Locked;
            }

            if (session.Submitted)
            {
                SetState(RunSubmissionStatus.Submitted, string.Empty);
                return;
            }

            if (!transportEnabled || !session.IsEligibleForSubmission || !session.HasResult)
            {
                SetState(RunSubmissionStatus.Locked, string.Empty);
                return;
            }

            if (status == RunSubmissionStatus.Locked)
                SetState(RunSubmissionStatus.Ready, string.Empty);
        }

        public bool TryBegin(out RunSubmissionPayload payload)
        {
            Refresh();
            payload = default;

            if (status != RunSubmissionStatus.Ready &&
                status != RunSubmissionStatus.SignInRequired &&
                status != RunSubmissionStatus.RetryableFailure)
            {
                return false;
            }

            int completionTimeMilliseconds;
            try
            {
                completionTimeMilliseconds =
                    RunScoreCalculator.CanonicalizeCompletionTimeMilliseconds(session.ElapsedSeconds);
            }
            catch (ArgumentOutOfRangeException)
            {
                SetState(RunSubmissionStatus.Rejected, "INVALID_RUN");
                return false;
            }

            int canonicalScore = RunScoreCalculator.CalculateFromMilliseconds(completionTimeMilliseconds);
            string canonicalRank = RunRankCalculator.CalculateFromMilliseconds(completionTimeMilliseconds);
            if (session.Score != canonicalScore ||
                !string.Equals(session.Rank, canonicalRank, StringComparison.Ordinal))
            {
                SetState(RunSubmissionStatus.Rejected, "LOCAL_RESULT_MISMATCH");
                return false;
            }

            trackedRunId = session.RunId;
            trackedCompletionTimeMilliseconds = completionTimeMilliseconds;
            payload = new RunSubmissionPayload(
                trackedRunId.ToString("D"),
                trackedCompletionTimeMilliseconds);
            SetState(RunSubmissionStatus.Submitting, string.Empty);
            return true;
        }

        public bool CompleteSuccess(
            string runId,
            int completionTimeMilliseconds,
            int score,
            string rank)
        {
            if (status != RunSubmissionStatus.Submitting ||
                !MatchesTrackedRun(runId) ||
                completionTimeMilliseconds != trackedCompletionTimeMilliseconds ||
                score != session.Score ||
                !string.Equals(rank, session.Rank, StringComparison.Ordinal) ||
                !session.MarkSubmitted())
            {
                SetState(RunSubmissionStatus.Rejected, "INVALID_RESPONSE");
                return false;
            }

            SetState(RunSubmissionStatus.Submitted, string.Empty);
            return true;
        }

        public void CompleteFailure(string runId, string errorCode)
        {
            if (status != RunSubmissionStatus.Submitting || !MatchesTrackedRun(runId))
            {
                SetState(RunSubmissionStatus.Rejected, "INVALID_RESPONSE");
                return;
            }

            switch (errorCode)
            {
                case "UNAUTHORIZED":
                    SetState(RunSubmissionStatus.SignInRequired, errorCode);
                    break;
                case "NETWORK_ERROR":
                case "INVALID_RESPONSE":
                case "RATE_LIMITED":
                case "SERVER_ERROR":
                    SetState(RunSubmissionStatus.RetryableFailure, errorCode);
                    break;
                case "SUBMISSION_DISABLED":
                    transportEnabled = false;
                    SetState(RunSubmissionStatus.Locked, errorCode);
                    break;
                default:
                    SetState(RunSubmissionStatus.Rejected, errorCode);
                    break;
            }
        }

        private bool MatchesTrackedRun(string runId)
        {
            return trackedRunId != Guid.Empty &&
                   string.Equals(runId, trackedRunId.ToString("D"), StringComparison.Ordinal);
        }

        private void SetState(RunSubmissionStatus nextStatus, string errorCode)
        {
            errorCode ??= string.Empty;
            if (status == nextStatus && string.Equals(lastErrorCode, errorCode, StringComparison.Ordinal))
                return;

            status = nextStatus;
            lastErrorCode = errorCode;
            Changed?.Invoke();
        }
    }
}
