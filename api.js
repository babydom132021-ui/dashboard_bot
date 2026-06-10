const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const Product = require('../models/Product');
const Order   = require('../models/Order');
const User    = require('../models/User');

// ─── Auth middleware (simple secret key) ──────────────────────────────────────
router.use((req, res, next) => {
    const key = req.headers['x-admin-key'] || req.query.key;
    if (key !== process.env.ADMIN_DASHBOARD_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});

// ─── STATS ────────────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
    try {
        const [
            totalOrders,
            totalRevenue,
            totalUsers,
            totalProducts,
            pendingOrders,
            paidOrders,
            shippingOrders,
            completedOrders,
            lowStockProducts,
            recentOrders,
            revenueByDay,
            topProducts
        ] = await Promise.all([
            Order.countDocuments(),
            Order.aggregate([{ $group: { _id: null, total: { $sum: '$totalPrice' } } }]),
            User.countDocuments(),
            Product.countDocuments(),
            Order.countDocuments({ status: 'pending_payment' }),
            Order.countDocuments({ status: 'pending' }),
            Order.countDocuments({ status: 'shipping' }),
            Order.countDocuments({ status: 'completed' }),
            Product.countDocuments({ stock: { $lte: 5 } }),
            Order.find().populate('user').sort({ createdAt: -1 }).limit(5),
            Order.aggregate([
                {
                    $group: {
                        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                        revenue: { $sum: '$totalPrice' },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } },
                { $limit: 14 }
            ]),
            Order.aggregate([
                { $unwind: '$items' },
                {
                    $group: {
                        _id: '$items.product',
                        totalQty: { $sum: '$items.quantity' },
                        totalRevenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } }
                    }
                },
                { $sort: { totalQty: -1 } },
                { $limit: 5 },
                { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'product' } },
                { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } }
            ])
        ]);

        res.json({
            totalOrders,
            totalRevenue: totalRevenue[0]?.total || 0,
            totalUsers,
            totalProducts,
            ordersByStatus: { pending_payment: pendingOrders, pending: paidOrders, shipping: shippingOrders, completed: completedOrders },
            lowStockProducts,
            recentOrders: recentOrders.map(o => ({
                _id: o._id,
                orderId: o.orderId,
                user: o.user ? `${o.user.firstName || ''} ${o.user.lastName || ''}`.trim() || o.user.username || 'N/A' : 'N/A',
                totalPrice: o.totalPrice,
                status: o.status,
                paymentStatus: o.paymentStatus,
                createdAt: o.createdAt
            })),
            revenueByDay,
            topProducts: topProducts.map(t => ({
                name: t.product?.name || 'Unknown',
                totalQty: t.totalQty,
                totalRevenue: t.totalRevenue
            }))
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ─── ORDERS ───────────────────────────────────────────────────────────────────
router.get('/orders', async (req, res) => {
    try {
        const { status, page = 1, limit = 20, search } = req.query;
        const query = {};
        if (status && status !== 'all') query.status = status;
        if (search) query.orderId = { $regex: search, $options: 'i' };

        const [orders, total] = await Promise.all([
            Order.find(query)
                .populate('user')
                .populate('items.product')
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(Number(limit)),
            Order.countDocuments(query)
        ]);

        res.json({
            orders: orders.map(o => ({
                _id: o._id,
                orderId: o.orderId || o._id,
                user: o.user ? {
                    name: `${o.user.firstName || ''} ${o.user.lastName || ''}`.trim() || o.user.username || 'N/A',
                    username: o.user.username,
                    telegramId: o.user.telegramId
                } : { name: 'N/A' },
                phone: o.phone,
                address: o.address,
                items: o.items.map(i => ({
                    name: i.product?.name || 'Deleted Product',
                    quantity: i.quantity,
                    price: i.price
                })),
                totalPrice: o.totalPrice,
                status: o.status,
                paymentStatus: o.paymentStatus || 'pending',
                createdAt: o.createdAt
            })),
            total,
            page: Number(page),
            pages: Math.ceil(total / limit)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.patch('/orders/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        const allowed = ['pending_payment', 'pending', 'shipping', 'completed'];
        if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
        const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
        if (!order) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true, order });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/orders/:id', async (req, res) => {
    try {
        await Order.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── PRODUCTS ─────────────────────────────────────────────────────────────────
router.get('/products', async (req, res) => {
    try {
        const { search, category, page = 1, limit = 20 } = req.query;
        const query = {};
        if (search) query.name = { $regex: search, $options: 'i' };
        if (category && category !== 'all') query.category = category;

        const [products, total] = await Promise.all([
            Product.find(query).sort({ name: 1 }).skip((page - 1) * limit).limit(Number(limit)),
            Product.countDocuments(query)
        ]);
        const categories = await Product.distinct('category');
        res.json({ products, total, categories, page: Number(page), pages: Math.ceil(total / limit) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/products', async (req, res) => {
    try {
        const { name, description, price, category, stock, image } = req.body;
        const product = new Product({ name, description, price, category, stock, image });
        await product.save();
        res.json({ success: true, product });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.patch('/products/:id', async (req, res) => {
    try {
        const product = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true });
        if (!product) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true, product });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/products/:id', async (req, res) => {
    try {
        await Product.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── USERS ────────────────────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
    try {
        const { search, page = 1, limit = 20 } = req.query;
        const query = {};
        if (search) {
            query.$or = [
                { firstName: { $regex: search, $options: 'i' } },
                { lastName: { $regex: search, $options: 'i' } },
                { username: { $regex: search, $options: 'i' } }
            ];
        }
        const [users, total] = await Promise.all([
            User.find(query).sort({ _id: -1 }).skip((page - 1) * limit).limit(Number(limit)),
            User.countDocuments(query)
        ]);

        // Attach order count per user
        const userIds = users.map(u => u._id);
        const orderCounts = await Order.aggregate([
            { $match: { user: { $in: userIds } } },
            { $group: { _id: '$user', count: { $sum: 1 }, total: { $sum: '$totalPrice' } } }
        ]);
        const orderMap = {};
        orderCounts.forEach(oc => { orderMap[oc._id.toString()] = oc; });

        res.json({
            users: users.map(u => ({
                _id: u._id,
                telegramId: u.telegramId,
                name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.username || 'N/A',
                username: u.username,
                phone: u.phone,
                address: u.address,
                isAdmin: u.isAdmin,
                orderCount: orderMap[u._id.toString()]?.count || 0,
                totalSpent: orderMap[u._id.toString()]?.total || 0
            })),
            total,
            page: Number(page),
            pages: Math.ceil(total / limit)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.patch('/users/:id/admin', async (req, res) => {
    try {
        const { isAdmin } = req.body;
        const user = await User.findByIdAndUpdate(req.params.id, { isAdmin }, { new: true });
        if (!user) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
