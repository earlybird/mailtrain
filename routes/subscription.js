'use strict';

const log = require('npmlog');
const config = require('config');
const router = require('../lib/router-async').create();
const confirmations = require('../models/confirmations');
const subscriptions = require('../models/subscriptions');
const lists = require('../models/lists');
const fields = require('../models/fields');
const shares = require('../models/shares');
const settings = require('../models/settings');
const _ = require('../lib/translate')._;
const contextHelpers = require('../lib/context-helpers');
const forms = require('../models/forms');

const { SubscriptionStatus } = require('../shared/lists');

const openpgp = require('openpgp');
const util = require('util');
const cors = require('cors');
const cache = require('memory-cache');
const geoip = require('geoip-ultralight');
const passport = require('../lib/passport');

const tools = require('../lib/tools-async');
const helpers = require('../lib/helpers');
const mailHelpers = require('../lib/subscription-mail-helpers');

const interoperableErrors = require('../shared/interoperable-errors');

const mjml = require('mjml');
const hbs = require('hbs');

const mjmlTemplates = new Map();
const objectHash = require('object-hash');

const bluebird = require('bluebird');
const fsReadFile = bluebird.promisify(require('fs').readFile);

const { cleanupFromPost } = require('../lib/helpers');

const originWhitelist = config.cors && config.cors.origins || [];

const corsOptions = {
    allowedHeaders: ['Content-Type', 'Origin', 'Accept', 'X-Requested-With'],
    methods: ['GET', 'POST'],
    optionsSuccessStatus: 200, // IE11 chokes on 204
    origin: (origin, callback) => {
        if (originWhitelist.includes(origin)) {
            callback(null, true);
        } else {
            const err = new Error(_('Not allowed by CORS'));
            err.status = 403;
            callback(err);
        }
    }
};

const corsOrCsrfProtection = (req, res, next) => {
    if (req.get('X-Requested-With') === 'XMLHttpRequest') {
        cors(corsOptions)(req, res, next);
    } else {
        passport.csrfProtection(req, res, next);
    }
};

async function takeConfirmationAndValidate(req, action, errorFactory) {
    const confirmation = await confirmations.takeConfirmation(req.params.cid);

    if (!confirmation || confirmation.action !== action) {
        throw errorFactory();
    }

    return confirmation;
}

async function injectCustomFormData(customFormId, viewKey, data) {
    function sortAndFilterCustomFieldsBy(key) {
        data.customFields = data.customFields.filter(fld => fld[key] !== null);
        data.customFields.sort((a, b) => a[key] - b[key]);
    }

    if (viewKey === 'web_subscribe') {
        sortAndFilterCustomFieldsBy('order_subscribe');
    } else if (viewKey === 'web_manage') {
        sortAndFilterCustomFieldsBy('order_manage');
    }

    if (!customFormId) {
        data.formInputStyle = '@import url(/subscription/form-input-style.css);';
        return;
    }

    const form = await forms.getById(contextHelpers.getAdminContext(), customFormId);

    data.template.template = form[viewKey] || data.template.template;
    data.template.layout = form.layout || data.template.layout;
    data.formInputStyle = form.formInputStyle || '@import url(/subscription/form-input-style.css);';

    const configItems = await settings.get(['uaCode']);

    data.uaCode = configItems.uaCode;
    data.customSubscriptionScripts = config.customsubscriptionscripts || [];
}

async function getMjmlTemplate(template) {
    let key = (typeof template === 'object') ? objectHash(template) : template;

    if (mjmlTemplates.has(key)) {
        return mjmlTemplates.get(key);
    }

    let source;
    if (typeof template === 'object') {
        source = await tools.mergeTemplateIntoLayout(template.template, template.layout);
    } else {
        source = await fsReadFile(path.join(__dirname, '..', 'views', template), 'utf-8');
    }

    const compiled = mjml.mjml2html(source);

    if (compiled.errors.length) {
        throw new Error(compiled.errors[0].message || compiled.errors[0]);
    }

    const renderer = hbs.handlebars.compile(compiled.html);
    mjmlTemplates.set(key, renderer);

    return renderer;
}

async function captureFlashMessages(res) {
    const renderAsync = bluebird.promisify(res.render.bind(res));
    return await renderAsync('subscription/capture-flash-messages', { layout: null });
}


router.getAsync('/confirm/subscribe/:cid', async (req, res) => {
    const confirmation = await takeConfirmationAndValidate(req, 'subscribe', () => new interoperableErrors.InvalidConfirmationForSubscriptionError('Request invalid or already completed. If your subscription request is still pending, please subscribe again.'));
    const data = confirmation.data;

    const meta = {
        ip: confirmation.ip,
        country: geoip.lookupCountry(confirmation.ip) || null,
        replaceOfUnsubscribedAllowed: true
    };

    const subscription = data.subscriptionData;
    subscription.email = data.email;
    subscription.status = SubscriptionStatus.SUBSCRIBED;

    try {
        await subscriptions.create(contextHelpers.getAdminContext(), confirmation.list, subscription, meta);
    } catch (err) {
        if (err instanceof interoperableErrors.DuplicitEmailError) {
            throw new interoperableErrors.DuplicitEmailError('Subscription already present'); // This is here to provide some meaningful error message.
        } else {
            throw err;
        }
    }

    const list = await lists.getById(contextHelpers.getAdminContext(), confirmation.list);
    subscription.cid = meta.cid;
    await mailHelpers.sendSubscriptionConfirmed(list, subscription.email, subscription);

    res.redirect('/subscription/' + encodeURIComponent(list.cid) + '/subscribed-notice');
});


router.getAsync('/confirm/change-address/:cid', async (req, res) => {
    const confirmation = await takeConfirmationAndValidate(req, 'change-address', () => new interoperableErrors.InvalidConfirmationForAddressChangeError('Request invalid or already completed. If your address change request is still pending, please change the address again.'));
    const list = await lists.getById(contextHelpers.getAdminContext(), confirmation.list);
    const data = confirmation.data;

    const subscription = await subscriptions.updateAddressAndGet(contextHelpers.getAdminContext(), list.id, data.subscriptionId, data.emailNew);

    await mailHelpers.sendSubscriptionConfirmed(list, data.emailNew, subscription);

    req.flash('info', _('Email address changed'));
    res.redirect('/subscription/' + encodeURIComponent(list.cid) + '/manage/' + subscription.cid);
});


router.getAsync('/confirm/unsubscribe/:cid', async (req, res) => {
    const confirmation = await takeConfirmationAndValidate(req, 'unsubscribe', () => new interoperableErrors.InvalidConfirmationForUnsubscriptionError('Request invalid or already completed. If your unsubscription request is still pending, please unsubscribe again.'));
    const list = await lists.getById(contextHelpers.getAdminContext(), confirmation.list);
    const data = confirmation.data;

    const subscription = await subscriptions.unsubscribeByCidAndGet(contextHelpers.getAdminContext(), list.id, data.subscriptionCid, data.campaignCid);

    await mailHelpers.sendUnsubscriptionConfirmed(list, subscription.email, subscription);

    res.redirect('/subscription/' + encodeURIComponent(list.cid) + '/unsubscribed-notice');
});


async function _renderSubscribe(req, res, list, subscription) {
    const data = {};
    data.email = subscription && subscription.email;
    data.layout = 'subscription/layout';
    data.title = list.name;
    data.cid = list.cid;
    data.csrfToken = req.csrfToken();

    data.customFields = await fields.forHbs(contextHelpers.getAdminContext(), list.id, subscription);
    data.useEditor = true;

    const configItems = await settings.get(['pgpPrivateKey', 'defaultAddress', 'defaultPostaddress']);
    data.hasPubkey = !!configItems.pgpPrivateKey;
    data.defaultAddress = configItems.defaultAddress;
    data.defaultPostaddress = configItems.defaultPostaddress;

    data.template = {
        template: 'subscription/web-subscribe.mjml.hbs',
        layout: 'subscription/layout.mjml.hbs'
    };

    await injectCustomFormData(req.query.fid || list.default_form, 'subscription/web-subscribe', data);

    const htmlRenderer = await getMjmlTemplate(data.template);

    data.isWeb = true;
    data.needsJsWarning = true;
    data.flashMessages = await captureFlashMessages(res);

    const result = htmlRenderer(data);

    res.send(result);
}

router.getAsync('/:cid', passport.csrfProtection, async (req, res) => {
    const list = await lists.getByCid(contextHelpers.getAdminContext(), req.params.cid);

    if (!list.public_subscribe) {
        shares.throwPermissionDenied();
    }

    const ucid = req.query.cid;

    let subscription;
    if (ucid) {
        try {
            subscription = await subscriptions.getByCid(contextHelpers.getAdminContext(), list.id, ucid);

            if (subscription.status === SubscriptionStatus.SUBSCRIBED) {
                subscription = null;
            }
        } catch (err) {
            if (err instanceof interoperableErrors.NotFoundError) {
            } else {
                throw err;
            }
        }
    }

    await _renderSubscribe(req, res, list, subscription);
});


router.options('/:cid/subscribe', cors(corsOptions));

router.postAsync('/:cid/subscribe', passport.parseForm, corsOrCsrfProtection, async (req, res) => {
    if (req.xhr) {
        req.needsAPIJSONResponse = true;
    }

    const list = await lists.getByCid(contextHelpers.getAdminContext(), req.params.cid);

    if (!list.public_subscribe) {
        shares.throwPermissionDenied();
    }

    const subscriptionData = await fields.fromPost(contextHelpers.getAdminContext(), list.id, req.body);

    const email = cleanupFromPost(req.body.EMAIL);

    if (!email) {
        if (req.xhr) {
            throw new Error('Email address not set');
        }

        req.flash('danger', _('Email address not set'));
        return await _renderSubscribe(req, res, list, subscriptionData);
    }

    const emailErr = await tools.validateEmail(email);
    if (emailErr) {
        const errMsg = tools.validateEmailGetMessage(emailErr, email);

        if (req.xhr) {
            throw new Error(errMsg);
        }

        req.flash('danger', errMsg);
        subscriptionData.email = email;
        return await _renderSubscribe(req, res, list, subscriptionData);
    }

    // Check if the subscriber seems legit. This is a really simple check, the only requirement is that
    // the subscriber has JavaScript turned on and thats it. If Mailtrain gets more targeted then this
    // simple check should be replaced with an actual captcha
    let subTime = Number(req.body.sub) || 0;
    // allow clock skew 24h in the past and 24h to the future
    let subTimeTest = !!(subTime > Date.now() - 24 * 3600 * 1000 && subTime < Date.now() + 24 * 3600 * 1000);
    let addressTest = !req.body.address;
    let testsPass = subTimeTest && addressTest;

    let existingSubscription;
    try {
        existingSubscription = await subscriptions.getByEmail(contextHelpers.getAdminContext(), list.id, email);
    } catch (err) {
        if (err instanceof interoperableErrors.NotFoundError) {
        } else {
            throw err;
        }
    }

    if (existingSubscription && existingSubscription.status === SubscriptionStatus.SUBSCRIBED) {
        await mailHelpers.sendAlreadySubscribed(list, email, existingSubscription);
        res.redirect('/subscription/' + encodeURIComponent(req.params.cid) + '/confirm-subscription-notice');

    } else {
        const data = {
            email,
            subscriptionData
        };

        const confirmCid = await confirmations.addConfirmation(list.id, 'subscribe', req.ip, data);

        if (!testsPass) {
            log.info('Subscription', 'Confirmation message for %s marked to be skipped (%s)', email, JSON.stringify(data));
        } else {
            await mailHelpers.sendConfirmSubscription(list, email, confirmCid, subscriptionData);
        }

        if (req.xhr) {
            return res.status(200).json({
                msg: _('Please Confirm Subscription')
            });
        }
        res.redirect('/subscription/' + encodeURIComponent(req.params.cid) + '/confirm-subscription-notice');
    }
});


router.options('/:cid/widget', cors(corsOptions));

router.getAsync('/:cid/widget', cors(corsOptions), async (req, res) => {
    req.needsAPIJSONResponse = true;

    const cached = cache.get(req.path);
    if (cached) {
        return res.status(200).json(cached);
    }

    const list = await lists.getByCid(contextHelpers.getAdminContext(), req.params.cid);

    const configItems = await settings.get(['serviceUrl', 'pgpPrivateKey']);

    const data = {
        title: list.name,
        cid: list.cid,
        serviceUrl: configItems.serviceUrl,
        hasPubkey: !!configItems.pgpPrivateKey,
        customFields: await fields.forHbs(contextHelpers.getAdminContext(), list.id),
        template: {},
        layout: null,
    };

    await injectCustomFormData(req.query.fid || list.default_form, 'subscription/web-subscribe', data);

    const renderAsync = bluebird.promisify(res.render);
    const html = await renderAsync('subscription/widget-subscribe', data);

    const response = {
        data: {
            title: data.title,
            cid: data.cid,
            html
        }
    };

    cache.put(req.path, response, 30000); // ms
    res.status(200).json(response);
});



router.getAsync('/:lcid/manage/:ucid', passport.csrfProtection, async (req, res) => {
    const list = await lists.getByCid(contextHelpers.getAdminContext(), req.params.lcid);

    const subscription = await subscriptions.getByCid(contextHelpers.getAdminContext(), list.id, req.params.ucid);

    if (subscription.status !== SubscriptionStatus.SUBSCRIBED) {
        throw new interoperableErrors.NotFoundError('Subscription not found in this list');
    }

    const data = {};
    data.email = subscription.email;
    data.cid = subscription.cid;
    data.lcid = req.params.lcid;
    data.title = list.name;
    data.csrfToken = req.csrfToken();
    data.layout = 'data/layout';

    data.customFields = await fields.forHbs(contextHelpers.getAdminContext(), list.id, subscription);

    data.useEditor = true;

    const configItems = await settings.get(['pgpPrivateKey', 'defaultAddress', 'defaultPostaddress']);
    data.hasPubkey = !!configItems.pgpPrivateKey;
    data.defaultAddress = configItems.defaultAddress;
    data.defaultPostaddress = configItems.defaultPostaddress;

    data.template = {
        template: 'subscription/web-manage.mjml.hbs',
        layout: 'subscription/layout.mjml.hbs'
    };

    await injectCustomFormData(req.query.fid || list.default_form, 'data/web-manage', data);

    const htmlRenderer = await getMjmlTemplate(data.template);

    data.isWeb = true;
    data.needsJsWarning = true;
    data.isManagePreferences = true;
    data.flashMessages = await captureFlashMessages(res);

    res.send(htmlRenderer(data));
});

router.postAsync('/:lcid/manage', passport.parseForm, passport.csrfProtection, async (req, res) => {
    const list = await lists.getByCid(contextHelpers.getAdminContext(), req.params.lcid);

    try {
        const subscriptionData = await fields.fromPost(contextHelpers.getAdminContext(), list.id, req.body);
        await subscriptions.updateManaged(contextHelpers.getAdminContext(), list.id, req.body.cid, subscriptionData);
    } catch (err) {
        if (err instanceof interoperableErrors.NotFoundError) {
            throw new interoperableErrors.NotFoundError('Subscription not found in this list');
        } else {
            throw err;
        }
    }

    res.redirect('/subscription/' + encodeURIComponent(req.params.lcid) + '/updated-notice');
});

router.getAsync('/:lcid/manage-address/:ucid', passport.csrfProtection, async (req, res) => {
    const list = await lists.getByCid(contextHelpers.getAdminContext(), req.params.lcid);
    const subscription = await subscriptions.getByCid(contextHelpers.getAdminContext(), list.id, req.params.ucid, false);

    if (subscription.status !== SubscriptionStatus.SUBSCRIBED) {
        throw new interoperableErrors.NotFoundError('Subscription not found in this list');
    }

    const configItems = await settings.get(['defaultAddress', 'defaultPostaddress']);

    const data = {};
    data.email = subscription.email;
    data.cid = subscription.cid;
    data.lcid = req.params.lcid;
    data.title = list.name;
    data.csrfToken = req.csrfToken();
    data.defaultAddress = configItems.defaultAddress;
    data.defaultPostaddress = configItems.defaultPostaddress;

    data.template = {
        template: 'subscription/web-manage-address.mjml.hbs',
        layout: 'subscription/layout.mjml.hbs'
    };

    await injectCustomFormData(req.query.fid || list.default_form, 'data/web-manage-address', data);

    const htmlRenderer = await getMjmlTemplate(data.template);

    data.isWeb = true;
    data.needsJsWarning = true;
    data.isManagePreferences = true;
    data.flashMessages = await captureFlashMessages(res);

    res.send(htmlRenderer(data));
});


router.postAsync('/:lcid/manage-address', passport.parseForm, passport.csrfProtection, async (req, res) => {
    const list = await lists.getByCid(contextHelpers.getAdminContext(), req.params.lcid);

    const emailNew = cleanupFromPost(req.body['EMAIL_NEW']);

    const subscription = await subscriptions.getByCid(contextHelpers.getAdminContext(), list.id, req.body.cid, false);

    if (subscription.status !== SubscriptionStatus.SUBSCRIBED) {
        throw new interoperableErrors.NotFoundError('Subscription not found in this list');
    }

    if (subscription.email === emailNew) {
        req.flash('info', _('Nothing seems to be changed'));

    } else {
        const emailErr = await tools.validateEmail(emailNew);
        if (emailErr) {
            const errMsg = tools.validateEmailGetMessage(emailErr, email);

            req.flash('danger', errMsg);

        } else {
            let newSubscription;
            try {
                newSubscription = await subscriptions.getByEmail(contextHelpers.getAdminContext(), list.id, emailNew, false);
            } catch (err) {
                if (err instanceof interoperableErrors.NotFoundError) {
                } else {
                    throw err;
                }
            }

            if (newSubscription && newSubscription.status === SubscriptionStatus.SUBSCRIBED) {
                await mailHelpers.sendAlreadySubscribed(list, emailNew, subscription);
            } else {
                const data = {
                    subscriptionId: subscription.id,
                    emailNew
                };

                const confirmCid = await confirmations.addConfirmation(list.id, 'change-address', req.ip, data);
                await mailHelpers.sendConfirmAddressChange(list, emailNew, confirmCid, subscription);
            }

            req.flash('info', _('An email with further instructions has been sent to the provided address'));
        }
    }

    res.redirect('/subscription/' + encodeURIComponent(req.params.lcid) + '/manage/' + encodeURIComponent(req.body.cid));
});


router.getAsync('/:lcid/unsubscribe/:ucid', passport.csrfProtection, async (req, res) => {
    const list = await lists.getByCid(contextHelpers.getAdminContext(), req.params.lcid);

    const configItems = await settings.get(['defaultAddress', 'defaultPostaddress']);

    const autoUnsubscribe = req.query.auto === 'yes';

    if (autoUnsubscribe) {
        handleUnsubscribe(list, req.params.ucid, autoUnsubscribe, req.query.c, req.ip, res, next);

    } else if (req.query.formTest ||
        list.unsubscription_mode === lists.UnsubscriptionMode.ONE_STEP_WITH_FORM ||
        list.unsubscription_mode === lists.UnsubscriptionMode.TWO_STEP_WITH_FORM) {

        const subscription = await subscriptions.getByCid(contextHelpers.getAdminContext(), list.id, req.params.ucid, false);

        if (subscription.status !== SubscriptionStatus.SUBSCRIBED) {
            throw new interoperableErrors.NotFoundError('Subscription not found in this list');
        }

        const data = {};
        data.email = subscription.email;
        data.lcid = req.params.lcid;
        data.ucid = req.params.ucid;
        data.title = list.name;
        data.csrfToken = req.csrfToken();
        data.campaign = req.query.c;
        data.defaultAddress = configItems.defaultAddress;
        data.defaultPostaddress = configItems.defaultPostaddress;

        data.template = {
            template: 'subscription/web-unsubscribe.mjml.hbs',
            layout: 'subscription/layout.mjml.hbs'
        };

        await injectCustomFormData(req.query.fid || list.default_form, 'subscription/web-unsubscribe', data);

        const htmlRenderer = await getMjmlTemplate(data.template);

        data.isWeb = true;
        data.needsJsWarning = true;
        data.isManagePreferences = true;
        data.flashMessages = await captureFlashMessages(res);

        res.send(htmlRenderer(data));

    } else { // UnsubscriptionMode.ONE_STEP || UnsubscriptionMode.TWO_STEP || UnsubscriptionMode.MANUAL
        await handleUnsubscribe(list, req.params.ucid, autoUnsubscribe, req.query.c, req.ip, res);
    }
});


router.postAsync('/:lcid/unsubscribe', passport.parseForm, passport.csrfProtection, async (req, res) => {
    const list = await lists.getByCid(contextHelpers.getAdminContext(), req.params.lcid);

    const campaignCid = cleanupFromPost(req.body.campaign);

    await handleUnsubscribe(list, req.body.ucid, false, campaignCid, req.ip, res);
});


async function handleUnsubscribe(list, subscriptionCid, autoUnsubscribe, campaignCid, ip, res) {
    if ((list.unsubscription_mode === lists.UnsubscriptionMode.ONE_STEP || list.unsubscription_mode === lists.UnsubscriptionMode.ONE_STEP_WITH_FORM) ||
        (autoUnsubscribe && (list.unsubscription_mode === lists.UnsubscriptionMode.TWO_STEP || list.unsubscription_mode === lists.UnsubscriptionMode.TWO_STEP_WITH_FORM)) ) {

        try {
            const subscription = await subscriptions.unsubscribeByCidAndGet(contextHelpers.getAdminContext(), list.id, subscriptionCid, campaignCid);

            await mailHelpers.sendUnsubscriptionConfirmed(list, subscription.email, subscription);

            res.redirect('/subscription/' + encodeURIComponent(list.cid) + '/unsubscribed-notice');

        } catch (err) {
            if (err instanceof interoperableErrors.NotFoundError) {
                throw new interoperableErrors.NotFoundError('Subscription not found in this list'); // This is here to provide some meaningful error message.
            }
        }

    } else {
        const subscription = await subscriptions.getByCid(contextHelpers.getAdminContext(), list.id, subscriptionCid, false);

        if (subscription.status !== SubscriptionStatus.SUBSCRIBED) {
            throw new interoperableErrors.NotFoundError('Subscription not found in this list');
        }

        if (list.unsubscription_mode === lists.UnsubscriptionMode.TWO_STEP || list.unsubscription_mode === lists.UnsubscriptionMode.TWO_STEP_WITH_FORM) {

            const data = {
                subscriptionCid,
                campaignCid
            };

            const confirmCid = await confirmations.addConfirmation(list.id, 'unsubscribe', ip, data);
            await mailHelpers.sendConfirmUnsubscription(list, subscription.email, confirmCid, subscription);

            res.redirect('/subscription/' + encodeURIComponent(list.cid) + '/confirm-unsubscription-notice');

        } else { // UnsubscriptionMode.MANUAL
            res.redirect('/subscription/' + encodeURIComponent(list.cid) + '/manual-unsubscribe-notice');
        }
    }
}


router.getAsync('/:cid/confirm-subscription-notice', async (req, res) => {
    await webNotice('confirm-subscription', req, res);
});

router.getAsync('/:cid/confirm-unsubscription-notice', async (req, res) => {
    await webNotice('confirm-unsubscription', req, res);
});

router.getAsync('/:cid/subscribed-notice', async (req, res) => {
    await webNotice('subscribed', req, res);
});

router.getAsync('/:cid/updated-notice', async (req, res) => {
    await webNotice('updated', req, res);
});

router.getAsync('/:cid/unsubscribed-notice', async (req, res) => {
    await webNotice('unsubscribed', req, res);
});

router.getAsync('/:cid/manual-unsubscribe-notice', async (req, res) => {
    await webNotice('manual-unsubscribe', req, res);
});

router.postAsync('/publickey', passport.parseForm, async (req, res) => {
    const configItems = await settings.get(['pgpPassphrase', 'pgpPrivateKey']);

    if (!configItems.pgpPrivateKey) {
        const err = new Error(_('Public key is not set'));
        err.status = 404;
        throw err;
    }

    let privKey;
    try {
        privKey = openpgp.key.readArmored(configItems.pgpPrivateKey).keys[0];
        if (configItems.pgpPassphrase && !privKey.decrypt(configItems.pgpPassphrase)) {
            privKey = false;
        }
    } catch (E) {
        // just ignore if failed
    }

    if (!privKey) {
        const err = new Error(_('Public key is not set'));
        err.status = 404;
        throw err;
    }

    const pubkey = privKey.toPublic().armor();

    res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename=public.asc'
    });

    res.end(pubkey);
});


async function webNotice(type, req, res) {
    const list = await lists.getByCid(contextHelpers.getAdminContext(), req.params.cid);

    const configItems = await settings.get(['defaultHomepage', 'serviceUrl', 'defaultAddress', 'defaultPostaddress', 'adminEmail']);


    const data = {
        title: list.name,
        homepage: configItems.defaultHomepage || configItems.serviceUrl,
        defaultAddress: configItems.defaultAddress,
        defaultPostaddress: configItems.defaultPostaddress,
        contactAddress: configItems.defaultAddress,
        template: {
            template: 'subscription/web-' + type + '-notice.mjml.hbs',
            layout: 'subscription/layout.mjml.hbs'
        }
    };

    await injectCustomFormData(req.query.fid || list.default_form, 'subscription/web-' + type + '-notice', data);

    const htmlRenderer = await getMjmlTemplate(data.template);

    data.isWeb = true;
    data.isConfirmNotice = true; // FIXME: Not sure what this does. Check it in a browser with disabled JS
    data.isManagePreferences = true;
    data.flashMessages = await captureFlashMessages(res);

    res.send(htmlRenderer(data));
}

module.exports = router;
