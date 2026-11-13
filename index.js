import functions from '@google-cloud/functions-framework';
import { handlePush, handleRenew } from './src/handlers.js';

export const onGmailPush = handlePush;
export const renewWatch = handleRenew;

functions.cloudEvent('onGmailPush', handlePush);
functions.http('renewWatch', handleRenew);
