// Launcher for `pnpm cassette:trim`: registers the clinic, then rewrites its cassette with only the
// answers a regression run asks for (nothing is written if the replay misses; the model is never called).
import { cassetteTrimMain, registerApp } from 'dialogwright';
import { clinicApp } from './index';

registerApp(clinicApp);
await cassetteTrimMain();
