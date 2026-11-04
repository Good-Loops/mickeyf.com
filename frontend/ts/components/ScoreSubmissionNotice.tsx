import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { API_BASE } from '@/config/apiConfig';
import { apiFetch } from '@/services/apiFetch';
import { createParentRegistrationApi } from '@/services/parentRegistrationApi';

const api = createParentRegistrationApi(API_BASE, apiFetch);

export function useShowScoreSubmissionNotice(): boolean {
    const { isAuthenticated, loading, userName, sessionGeneration } = useAuth();
    const [result, setResult] = useState<{ userName: string | null; sessionGeneration: number; show: boolean } | null>(null);

    useEffect(() => {
        if (loading || !isAuthenticated) { setResult(null); return; }
        const controller = new AbortController();
        void api.scoreStatus(null, controller.signal)
            .then(status => {
                if (!controller.signal.aborted) setResult({ userName, sessionGeneration, show: status.visibility !== 'public' });
            })
            .catch(() => {
                if (!controller.signal.aborted) setResult({ userName, sessionGeneration, show: true });
            });
        return () => controller.abort();
    }, [loading, isAuthenticated, userName, sessionGeneration]);

    if (loading) return false;
    if (!isAuthenticated) return true;
    return result?.userName === userName && result.sessionGeneration === sessionGeneration ? result.show : false;
}

type ScoreSubmissionNoticeProps = Readonly<{
    isAuthenticated: boolean;
    loading: boolean;
    show: boolean;
}>;

const ScoreSubmissionNotice: React.FC<ScoreSubmissionNoticeProps> = ({
    isAuthenticated,
    loading,
    show,
}) => (
    !loading && show
        ? isAuthenticated ? (
            <p className="score-submission-notice">
                Public leaderboard participation is optional. <Link to="/account">Manage your choice</Link>.
            </p>
        ) : (
            <p className="score-submission-notice" role="status">
                <Link to="/login">Log in</Link> or <Link to="/signup">sign up</Link>
                {' '}before starting a run to submit scores. Public leaderboard participation is optional.
            </p>
        )
        : null
);

export default ScoreSubmissionNotice;
