/**
 * Application bootstrap entry point.
 *
 * Responsibilities:
 * - Creates the React root and mounts `<App />` into the DOM.
 * - Establishes top-level providers (router, auth) required across routes.
 * - Loads the application shell after global styles and providers are available.
 *
 * Ownership boundary: this file composes bootstrap concerns only; app logic lives in feature modules, hooks, and
 * services.
 */
/// <reference types="vite/client" />

import ReactDOM from "react-dom/client";
import { Capacitor } from '@capacitor/core';
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "@/context/AuthContext";
import App from "@/App";
import { loadAppFonts } from "@/layout/loadAppFonts";
import "../sass/style.scss";

loadAppFonts();

// Apply native viewport rules before the first React frame; web routes stay unchanged.
if (Capacitor.isNativePlatform()) document.documentElement.dataset.nativeApp = Capacitor.getPlatform();

ReactDOM.createRoot(document.getElementById("root")!).render(
	<BrowserRouter>
    	<AuthProvider>
			<App />
    	</AuthProvider>
  	</BrowserRouter>
);
