/**
 * Header component with navigation links.
 * Shows different links based on authentication status.
 */
import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';

const Header: React.FC = () => {
    const { isAuthenticated, userName, logout } = useAuth();

    const handleLogout = () => {
        logout();
    };

    return (
        <header className="header">
        <nav className="nav">
            <ul className="nav__list">
            <li className="nav__item">
                <NavLink className="nav__link" to="/" end>
                Home
                </NavLink>
            </li>
            <li className="nav__item">
                <NavLink className="nav__link" to="/animations">
                Animations
                </NavLink>
            </li>
            <li className="nav__item">
                <NavLink className="nav__link" to="/games">
                Games
                </NavLink>
            </li>
            <li className="nav__item">
                <NavLink className="nav__link" to="/leaderboards">
                Leaderboards
                </NavLink>
            </li>
            <li className="nav__item">
                <NavLink className="nav__link" to="/social">
                Social
                </NavLink>
            </li>

            {!isAuthenticated && (
                <>
                <li className="nav__item">
                    <NavLink className="nav__link" to="/login">
                    Login
                    </NavLink>
                </li>
                <li className="nav__item">
                    <NavLink className="nav__link" to="/register">
                    Register
                    </NavLink>
                </li>
                </>
            )}

            {isAuthenticated && (
                <li className="nav__item">
                    <a className="nav__link nav__link--logout" onClick={handleLogout}>
                        Logout
                    </a>
                </li>
            )}
            </ul>
        </nav>

        {isAuthenticated && (
            <div className="header__user">
                Logged in as: <strong>{userName}</strong>
            </div>
        )}
        </header>
    );
};

export default Header;
