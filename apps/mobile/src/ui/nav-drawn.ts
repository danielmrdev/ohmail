/**
 * WHETHER THE APP'S NAVIGATION IS DRAWN AT ALL. The dock and the rail stand only once a mailbox is
 * open (`gateFor(...).to === "mail"`); the connect flow has neither, so a screen there owes no
 * clearance for them. The root provides it beside the rail; absent, the navigation is drawn.
 */
import { createContext, useContext } from "react";

export const NavDrawnContext = createContext(true);

export function useNavDrawn(): boolean {
  return useContext(NavDrawnContext);
}
