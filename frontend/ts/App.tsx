/**
 * SPA application shell.
 * Composes the top-level layout (header/footer) and the client-side route table.
 * Ownership: this module wires pages and navigation only; domain logic lives in feature modules, hooks, and services.
 */
import "pixi.js/unsafe-eval";
import React from "react";
import { Routes, Route } from "react-router-dom";
import Header from "@/Header";
import Home from "@/pages/Home";

import Animations from "@/pages/Animations";
import DancingCircles from "@/pages/animations/DancingCircles";
import DancingFractals from "@/pages/animations/DancingFractals";

import Games from "@/pages/Games";
import P4Vega from "@/pages/games/P4Vega";
import ThreeBosses from "@/pages/games/ThreeBosses";
import {
	isThreeBossesLocalEnabled,
	THREE_BOSSES_LOCAL_ROUTE,
} from '@/config/featureFlags';

import Leaderboard from "@/pages/Leaderboard";
import GameLeaderboard from "@/pages/leaderboards/GameLeaderboard";
import Social from "@/pages/Social";
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import NotFound from "@/pages/NotFound";

const App: React.FC = () => {
  return (
	<div className="app-shell">
		<div className="space-background" aria-hidden="true">
			<div className="space-background__stars space-background__stars--far" />
			<div className="space-background__stars space-background__stars--near" />
			<div className="space-background__nebula" />
			<div className="space-background__celestial space-background__celestial--galaxy-barred" />
			<div className="space-background__celestial space-background__celestial--galaxy-broad" />
			<div className="space-background__celestial space-background__celestial--galaxy-edge" />
			<div className="space-background__celestial space-background__celestial--galaxy-ring" />
			<div className="space-background__celestial space-background__celestial--nebula-hourglass" />
			<div className="space-background__celestial space-background__celestial--quasar-jet" />
			<div className="space-background__celestial space-background__celestial--quasar-radio" />
			<div className="space-background__celestial space-background__celestial--quasar-lensed" />
		</div>
		<Header />
		<main className="main">
			<Routes>
				<Route path="/" element={<Home />} />

				<Route path="/animations/*" element={<Animations />} />
				<Route path="/animations/dancing-circles" element={<DancingCircles />} />
				<Route path="/animations/dancing-fractals" element={<DancingFractals />} />
				
				<Route path="/games" element={<Games />} />
				<Route path="/games/p4-Vega" element={<P4Vega />} />
				{isThreeBossesLocalEnabled && (
					<Route path={THREE_BOSSES_LOCAL_ROUTE} element={<ThreeBosses />} />
				)}

				<Route path="/leaderboards" element={<Leaderboard />} />
				<Route path="/leaderboards/:gameId" element={<GameLeaderboard />} />
				<Route path="/social" element={<Social />} />
				<Route path="/login" element={<Login />} />
				<Route path="/register" element={<Register />} />
				<Route path="*" element={<NotFound />} />
			</Routes>
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
