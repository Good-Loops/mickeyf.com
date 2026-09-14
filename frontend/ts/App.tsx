/**
 * SPA application shell.
 * Composes the top-level layout (header/footer) and the client-side route table.
 * Ownership: this module wires pages and navigation only; domain logic lives in feature modules, hooks, and services.
 */
import React, { lazy, useRef } from "react";
import { useSafariBackgroundEdges } from '@/hooks/useSafariBackgroundEdges';
import { Routes, Route, useLocation } from "react-router-dom";
import RouteContentBoundary from '@/components/RouteContentBoundary';
import Header from "@/Header";
import Home from "@/pages/Home";

import { isThreeBossesAvailableInCurrentBrowser } from '@/games/three-bosses/unityVisibility';
import {
	isThreeBossesEnabled,
	isThreeBossesReleaseEnabled,
	THREE_BOSSES_ROUTE,
} from '@/config/featureFlags';

import NotFound from "@/pages/NotFound";

// Home and recovery stay immediate; every destination shares the route loading boundary.
const Animations = lazy(() => import('@/pages/Animations'));
const Games = lazy(() => import('@/pages/Games'));
const DancingCircles = lazy(() => import('@/pages/animations/DancingCircles'));
const DancingFractals = lazy(() => import('@/pages/animations/DancingFractals'));
const P4Vega = lazy(() => import('@/pages/games/P4Vega'));
const ThreeBossesAvailabilityGate = lazy(() => import('@/pages/games/ThreeBosses')
	.then(module => ({ default: module.ThreeBossesAvailabilityGate })));
const Leaderboard = lazy(() => import('@/pages/Leaderboard'));
const GameLeaderboard = lazy(() => import('@/pages/leaderboards/GameLeaderboard'));
const Connect = lazy(() => import('@/pages/Connect'));
const Login = lazy(() => import('@/pages/Login'));
const SignUp = lazy(() => import('@/pages/SignUp'));
const ManageAccount = lazy(() => import('@/pages/ManageAccount'));

const App: React.FC = () => {
	const shellRef = useRef<HTMLDivElement>(null);
	const { pathname } = useLocation();
	useSafariBackgroundEdges(shellRef);
	const threeBossesAvailable = isThreeBossesEnabled
		&& isThreeBossesAvailableInCurrentBrowser(undefined, isThreeBossesReleaseEnabled);

	return (
	<div className="app-shell" ref={shellRef}>
		<div className="space-background" aria-hidden="true">
			<div className="space-background__stars space-background__stars--far" />
			<div className="space-background__stars space-background__stars--near" />
			<div className="space-background__nebula" />
			<div className="space-background__celestial space-background__celestial--galaxy-interacting-pair" />
			<div className="space-background__celestial space-background__celestial--galaxy-broad" />
			<div className="space-background__celestial space-background__celestial--galaxy-edge" />
			<div className="space-background__celestial space-background__celestial--galaxy-ring" />
			<div className="space-background__celestial space-background__celestial--nebula-hourglass" />
			<div className="space-background__celestial space-background__celestial--wolf-rayet-cocoon" />
			<div className="space-background__celestial space-background__celestial--quasar-jet" />
			<div className="space-background__celestial space-background__celestial--wolf-rayet-shells" />
			<div className="space-background__celestial space-background__celestial--quasar-lensed" />
		</div>
		<Header />
		<main className="main">
			<RouteContentBoundary key={pathname}>
				<Routes>
					<Route path="/" element={<Home />} />

					<Route path="/animations/*" element={<Animations />} />
					<Route path="/animations/dancing-circles" element={<DancingCircles />} />
					<Route path="/animations/dancing-fractals" element={<DancingFractals />} />

					<Route
						path="/games"
						element={<Games threeBossesAvailable={threeBossesAvailable} />}
					/>
					<Route path="/games/p4-Vega" element={<P4Vega />} />
					{isThreeBossesEnabled && (
						<Route
							path={THREE_BOSSES_ROUTE}
							element={<ThreeBossesAvailabilityGate />}
						/>
					)}

					<Route path="/leaderboards" element={<Leaderboard />} />
					<Route path="/leaderboards/:gameId" element={<GameLeaderboard />} />
					<Route path="/connect" element={<Connect />} />
					<Route path="/login" element={<Login />} />
					<Route path="/signup" element={<SignUp />} />
					<Route path="/account" element={<ManageAccount />} />
					<Route path="*" element={<NotFound />} />
				</Routes>
			</RouteContentBoundary>
		</main>
		<footer className="footer">
			<p className="footer__text">
			© 2024 Michel Fingergut {/* · Portfolio */}
			</p>
		</footer>
    </div>
  );
}

export default App;
