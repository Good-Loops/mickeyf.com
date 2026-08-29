/**
 * Header component with navigation links.
 * Shows different links based on authentication status.
 */
import React, { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';

type NavGroup = 'entertainment' | 'account';

const Header: React.FC = () => {
    const { isAuthenticated, userName, logout } = useAuth();
    const { pathname } = useLocation();
    const navRef = useRef<HTMLElement | null>(null);
    const [openGroup, setOpenGroup] = useState<NavGroup | null>(null);

    const routeBelongsTo = (basePath: string) => (
        pathname === basePath || pathname.startsWith(`${basePath}/`)
    );

    const entertainmentIsActive = ['/animations', '/games', '/leaderboards']
        .some(routeBelongsTo);
    const accountIsActive = ['/login', '/register'].some(routeBelongsTo);

    useEffect(() => {
        setOpenGroup(null);
    }, [pathname]);

    useEffect(() => {
        const closeWhenClickingOutside = (event: PointerEvent) => {
            if (!navRef.current?.contains(event.target as Node)) {
                setOpenGroup(null);
            }
        };

        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') {
                return;
            }

            const openTrigger = navRef.current?.querySelector<HTMLButtonElement>(
                '.nav__dropdown-trigger[aria-expanded="true"]'
            );

            if (!openTrigger) {
                return;
            }

            event.preventDefault();
            setOpenGroup(null);
            openTrigger.focus();
        };

        document.addEventListener('pointerdown', closeWhenClickingOutside);
        document.addEventListener('keydown', closeOnEscape);

        return () => {
            document.removeEventListener('pointerdown', closeWhenClickingOutside);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, []);

    const toggleGroup = (group: NavGroup) => {
        setOpenGroup((currentGroup) => currentGroup === group ? null : group);
    };

    const handleLogout = () => {
        setOpenGroup(null);
        logout();
    };

    return (
        <header className="header">
            <nav className="nav" aria-label="Primary navigation" ref={navRef}>
                <ul className="nav__list">
                    <li className="nav__item">
                        <NavLink className="nav__link" to="/" end>
                            Home
                        </NavLink>
                    </li>

                    <li className="nav__item nav__dropdown">
                        <button
                            className={`nav__link nav__dropdown-trigger${entertainmentIsActive ? ' nav__link--group-active' : ''}`}
                            type="button"
                            aria-expanded={openGroup === 'entertainment'}
                            aria-controls="entertainment-navigation"
                            onClick={() => toggleGroup('entertainment')}
                        >
                            Entertainment
                            <span className="nav__dropdown-chevron" aria-hidden="true" />
                        </button>
                        <ul
                            className="nav__dropdown-menu"
                            id="entertainment-navigation"
                            aria-label="Entertainment"
                            hidden={openGroup !== 'entertainment'}
                        >
                            <li>
                                <NavLink className="nav__dropdown-link" to="/animations" onClick={() => setOpenGroup(null)}>
                                    Animations
                                </NavLink>
                            </li>
                            <li>
                                <NavLink className="nav__dropdown-link" to="/games" onClick={() => setOpenGroup(null)}>
                                    Games
                                </NavLink>
                            </li>
                            <li>
                                <NavLink className="nav__dropdown-link" to="/leaderboards" onClick={() => setOpenGroup(null)}>
                                    Leaderboards
                                </NavLink>
                            </li>
                        </ul>
                    </li>

                    <li className="nav__item">
                        <NavLink className="nav__link" to="/connect">
                            Connect
                        </NavLink>
                    </li>

                    <li className="nav__item nav__dropdown">
                        <button
                            className={`nav__link nav__dropdown-trigger${accountIsActive ? ' nav__link--group-active' : ''}`}
                            type="button"
                            aria-expanded={openGroup === 'account'}
                            aria-controls="account-navigation"
                            onClick={() => toggleGroup('account')}
                        >
                            Account
                            <span className="nav__dropdown-chevron" aria-hidden="true" />
                        </button>
                        <ul
                            className="nav__dropdown-menu"
                            id="account-navigation"
                            aria-label="Account"
                            hidden={openGroup !== 'account'}
                        >
                            {!isAuthenticated && (
                                <>
                                    <li>
                                        <NavLink className="nav__dropdown-link" to="/login" onClick={() => setOpenGroup(null)}>
                                            Login
                                        </NavLink>
                                    </li>
                                    <li>
                                        <NavLink className="nav__dropdown-link" to="/register" onClick={() => setOpenGroup(null)}>
                                            Register
                                        </NavLink>
                                    </li>
                                </>
                            )}

                            {isAuthenticated && (
                                <>
                                    <li className="nav__account-name">
                                        Signed in as <strong>{userName ?? 'user'}</strong>
                                    </li>
                                    <li>
                                        <button
                                            className="nav__dropdown-link"
                                            type="button"
                                            onClick={handleLogout}
                                        >
                                            Logout
                                        </button>
                                    </li>
                                </>
                            )}
                        </ul>
                    </li>
                </ul>
            </nav>
        </header>
    );
};

export default Header;
