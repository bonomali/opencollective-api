import config from 'config';
import { get } from 'lodash';

import * as constants from '../../constants/transactions';
import logger from '../../lib/logger';
import { floatAmountToCents } from '../../lib/math';
import * as libpayments from '../../lib/payments';
import models from '../../models';

/** Build an URL for the PayPal API */
export function paypalUrl(path) {
  if (path.startsWith('/')) {
    throw new Error("Please don't use absolute paths");
  }
  const baseUrl =
    config.paypal.payment.environment === 'sandbox'
      ? 'https://api.sandbox.paypal.com/v1/'
      : 'https://api.paypal.com/v1/';
  return new URL(baseUrl + path).toString();
}

/** Exchange clientid and secretid by an auth token with PayPal API */
export async function retrieveOAuthToken({ clientId, clientSecret }) {
  const url = paypalUrl('oauth2/token');
  const body = 'grant_type=client_credentials';
  /* The OAuth token entrypoint uses Basic HTTP Auth */
  const authStr = `${clientId}:${clientSecret}`;
  const basicAuth = Buffer.from(authStr).toString('base64');
  const headers = { Authorization: `Basic ${basicAuth}` };
  /* Execute the request and unpack the token */
  const response = await fetch(url, { method: 'post', body, headers });
  const jsonOutput = await response.json();
  return jsonOutput.access_token;
}

/** Assemble POST requests for communicating with PayPal API */
export async function paypalRequest(urlPath, body, hostCollective) {
  const connectedPaypalAccounts = await hostCollective.getConnectedAccounts({
    where: { service: 'paypal', deletedAt: null },
    order: [['createdAt', 'DESC']],
  });
  const paypal = connectedPaypalAccounts[0];
  if (!paypal || !paypal.clientId || !paypal.token) {
    throw new Error("Host doesn't support PayPal payments.");
  }
  const url = paypalUrl(urlPath);
  const token = await retrieveOAuthToken({ clientId: paypal.clientId, clientSecret: paypal.token });
  const params = {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };

  const result = await fetch(url, params);
  if (!result.ok) {
    let errorData = null;
    let errorMessage = 'PayPal payment rejected';
    try {
      errorData = await result.json();
      errorMessage = `${errorMessage}: ${errorData.message}`;
    } catch (e) {
      errorData = e;
    }
    logger.error('PayPal payment failed', result, errorData);
    throw new Error(errorMessage);
  }
  return result.json();
}

/** Create a new payment object in the PayPal API
 *
 * It's just a wrapper to the PayPal API method `create-payment':
 * https://developer.paypal.com/docs/integration/direct/express-checkout/integration-jsv4/advanced-payments-api/create-express-checkout-payments/
 */
export async function createPayment(req, res) {
  const { amount, currency, hostId } = req.body;
  if (!amount || !currency) {
    throw new Error('Amount & Currency are required');
  }
  const hostCollective = await models.Collective.findByPk(hostId);
  if (!hostCollective) {
    throw new Error("Couldn't find host collective");
  }
  /* eslint-disable camelcase */
  const paymentParams = {
    intent: 'sale',
    payer: { payment_method: 'paypal' },
    transactions: [{ amount: { total: amount, currency } }],
    /* The values bellow are required by the PayPal API but they're
       not really used so they were just filled in with something
       reasonable. */
    redirect_urls: {
      return_url: 'https://opencollective.com',
      cancel_url: 'https://opencollective.com',
    },
  };
  /* eslint-enable camelcase */
  const payment = await paypalRequest('payments/payment', paymentParams, hostCollective);
  return res.json({ id: payment.id });
}

/** Execute an already created payment
 *
 * It's just a wrapper to the PayPal API method `execute-payment':
 * https://developer.paypal.com/docs/integration/direct/express-checkout/execute-payments/
 */
export async function executePayment(order) {
  const hostCollective = await order.collective.getHostCollective();
  const { paymentID, payerID } = order.paymentMethod.data;
  return paypalRequest(
    `payments/payment/${paymentID}/execute`,
    {
      payer_id: payerID, // eslint-disable-line camelcase
    },
    hostCollective,
  );
}

/** Create transaction in our database to reflect a PayPal charge */
export async function createTransaction(order, paymentInfo) {
  const transaction = paymentInfo.transactions[0];
  const amountFromPayPal = parseFloat(transaction.amount.total);
  const paypalFee = parseFloat(get(transaction, 'related_resources.0.sale.transaction_fee.value', '0.0'));
  const amountFromPayPalInCents = floatAmountToCents(amountFromPayPal);
  const paypalFeeInCents = floatAmountToCents(paypalFee);
  const currencyFromPayPal = transaction.amount.currency;

  const hostFeeInHostCurrency = libpayments.calcFee(amountFromPayPalInCents, order.collective.hostFeePercent);
  const platformFeeInHostCurrency = libpayments.getPlatformFee(order);

  const payload = {
    CreatedByUserId: order.createdByUser.id,
    FromCollectiveId: order.FromCollectiveId,
    CollectiveId: order.collective.id,
    PaymentMethodId: order.paymentMethod.id,
  };
  payload.transaction = {
    type: constants.TransactionTypes.CREDIT,
    OrderId: order.id,
    amount: order.totalAmount,
    currency: order.currency,
    hostCurrency: currencyFromPayPal,
    amountInHostCurrency: amountFromPayPalInCents,
    hostCurrencyFxRate: order.totalAmount / amountFromPayPalInCents,
    hostFeeInHostCurrency,
    platformFeeInHostCurrency,
    paymentProcessorFeeInHostCurrency: paypalFeeInCents,
    taxAmount: order.taxAmount,
    description: order.description,
    data: {
      ...paymentInfo,
      isFeesOnTop: order.data?.isFeesOnTop,
    },
  };
  return models.Transaction.createFromPayload(payload);
}

/** Process order in paypal and create transactions in our db */
export async function processOrder(order) {
  const paymentInfo = await executePayment(order);
  logger.info('PayPal Payment');
  logger.info(paymentInfo);
  const transaction = await createTransaction(order, paymentInfo);
  await order.update({ processedAt: new Date() });
  await order.paymentMethod.update({ confirmedAt: new Date() });
  return transaction;
}

/* Interface expected for a payment method */
export default {
  features: {
    recurring: false,
  },
  processOrder,
};
