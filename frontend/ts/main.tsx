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
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "@/context/AuthContext";
import App from "@/App";
import "../sass/style.scss";

ReactDOM.createRoot(document.getElementById("root")!).render(
	<BrowserRouter>
    	<AuthProvider>
			<App />
    	</AuthProvider>
  	</BrowserRouter>
);
