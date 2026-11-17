"use client";

import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from "@ui-sdk/react/navigation-menu";
import { site } from "../site.config.ts";
import { ConfigLink } from "./external-link.tsx";
import { ChevronDownIcon } from "./icons.tsx";
import { PRODUCT_LINKS } from "./nav-links.ts";

export function DesktopNav() {
  return (
    <NavigationMenu aria-label="Main" closeOnSelect>
      <NavigationMenuList>
        <NavigationMenuItem value="product">
          <NavigationMenuTrigger>
            Product
            <ChevronDownIcon />
          </NavigationMenuTrigger>
          <NavigationMenuContent side="bottom" align="start" sideOffset={8}>
            <ul className="grid grid-cols-2 gap-1">
              {PRODUCT_LINKS.map((link) => (
                <li key={link.href}>
                  <NavigationMenuLink href={link.href}>
                    <span className="block text-sm font-medium text-fg">{link.title}</span>
                    <span className="mt-0.5 block text-sm leading-snug text-muted">{link.hint}</span>
                  </NavigationMenuLink>
                </li>
              ))}
            </ul>
          </NavigationMenuContent>
        </NavigationMenuItem>
        <NavigationMenuItem value="how-it-works">
          <NavigationMenuLink href="/#how-it-works" className="nav-link">
            How it works
          </NavigationMenuLink>
        </NavigationMenuItem>
        <NavigationMenuItem value="pricing">
          <NavigationMenuLink href="/#pricing" className="nav-link">
            Pricing
          </NavigationMenuLink>
        </NavigationMenuItem>
        <NavigationMenuItem value="docs">
          <ConfigLink href={site.docsUrl} label="Docs" className="nav-link" compact />
        </NavigationMenuItem>
        <NavigationMenuItem value="github">
          <ConfigLink href={site.githubUrl} label="GitHub" className="nav-link" compact />
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  );
}
