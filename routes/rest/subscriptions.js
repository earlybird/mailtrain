'use strict';

const passport = require('../../lib/passport');
const subscriptions = require('../../models/subscriptions');

const router = require('../../lib/router-async').create();


router.postAsync('/subscriptions-table/:listId/:segmentId?', passport.loggedIn, async (req, res) => {
    return res.json(await subscriptions.listDTAjax(req.context, req.params.listId, req.params.segmentId, req.body));
});

router.getAsync('/subscriptions/:listId/:subscriptionId', passport.loggedIn, async (req, res) => {
    const entity = await subscriptions.getById(req.context, req.params.listId, req.params.subscriptionId);
    entity.hash = await subscriptions.hashByList(req.params.listId, entity);
    return res.json(entity);
});

router.postAsync('/subscriptions/:listId', passport.loggedIn, passport.csrfProtection, async (req, res) => {
    await subscriptions.create(req.context, req.params.listId, req.body);
    return res.json();
});

router.putAsync('/subscriptions/:listId/:subscriptionId', passport.loggedIn, passport.csrfProtection, async (req, res) => {
    const entity = req.body;
    entity.id = parseInt(req.params.subscriptionId);

    await subscriptions.updateWithConsistencyCheck(req.context, req.params.listId, entity);
    return res.json();
});

router.deleteAsync('/subscriptions/:listId/:subscriptionId', passport.loggedIn, passport.csrfProtection, async (req, res) => {
    await subscriptions.remove(req.context, req.params.listId, req.params.subscriptionId);
    return res.json();
});

router.postAsync('/subscriptions-validate/:listId', passport.loggedIn, async (req, res) => {
    return res.json(await subscriptions.serverValidate(req.context, req.params.listId, req.body));
});

router.postAsync('/subscriptions-unsubscribe/:listId/:subscriptionId', passport.loggedIn, passport.csrfProtection, async (req, res) => {
    await subscriptions.unsubscribe(req.context, req.params.listId, req.params.subscriptionId);
    return res.json();
});


module.exports = router;