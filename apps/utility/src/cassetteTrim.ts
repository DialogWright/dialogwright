// Launcher for `pnpm cassette:trim`: registers the app, then rewrites its cassette with only the
// answers a regression run asks for (nothing is written if the replay misses; the model is never called).
import { cassetteTrimMain, registerApp } from 'dialogwright';
import { app } from './index';

registerApp(app);
await cassetteTrimMain();
