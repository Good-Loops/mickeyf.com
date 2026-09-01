import React from 'react';
import { Link } from 'react-router-dom';

type ScoreSubmissionNoticeProps = Readonly<{
    isAuthenticated: boolean;
    loading: boolean;
}>;

const ScoreSubmissionNotice: React.FC<ScoreSubmissionNoticeProps> = ({
    isAuthenticated,
    loading,
}) => (
    !loading && !isAuthenticated
        ? (
            <p className="score-submission-notice" role="status">
                <Link to="/login">Log in</Link> or <Link to="/signup">sign up</Link>
                {' '}before starting a run to submit scores.
            </p>
        )
        : null
);

export default ScoreSubmissionNotice;
