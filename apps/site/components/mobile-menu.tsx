"use client";

import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@ui-sdk/react/dialog";
import { site } from "../site.config.ts";
import { ConfigLink } from "./external-link.tsx";
import { CloseIcon, MenuIcon } from "./icons.tsx";
import { Wordmark } from "./logo.tsx";
import { PRODUCT_LINKS } from "./nav-links.ts";

const linkClass = "flex min-h-11 items-center rounded-lg px-3 text-base text-fg hover:bg-hover";

export function MobileMenu() {
  return (
    <Dialog>
      <DialogTrigger className="btn btn-ghost px-3" aria-label="Open menu">
        <MenuIcon size={20} />
      </DialogTrigger>
      <DialogBackdrop />
      <DialogContent className="mobile-menu" keepMounted>
        <div className="flex items-center justify-between">
          <DialogTitle className="m-0">
            <span className="visually-hidden">Menu</span>
            <Wordmark />
          </DialogTitle>
          <DialogClose className="btn btn-ghost px-3" aria-label="Close menu">
            <CloseIcon size={20} />
          </DialogClose>
        </div>
        <nav aria-label="Mobile" className="mt-4">
          <ul className="grid gap-0.5">
            {PRODUCT_LINKS.map((link) => (
              <li key={link.href}>
                <DialogClose render={<a href={link.href} />} className={linkClass}>
                  {link.title}
                </DialogClose>
              </li>
            ))}
            <li>
              <DialogClose render={<a href="/#pricing" />} className={linkClass}>
                Pricing
              </DialogClose>
            </li>
            <li>
              <ConfigLink href={site.docsUrl} label="Docs" className={linkClass} />
            </li>
            <li>
              <ConfigLink href={site.githubUrl} label="GitHub" className={linkClass} />
            </li>
          </ul>
        </nav>
        <div className="mt-6 grid gap-2">
          <a href="/request-access" className="btn btn-primary w-full">
            Request access
          </a>
          <a href={site.appUrl} className="btn btn-secondary w-full">
            Sign in
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
