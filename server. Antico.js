 require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();

const ASAAS_API_KEY = process.env.ASAAS_API_KEY || '';
const FONNTE_TOKEN = process.env.FONNTE_TOKEN || '';
const ASAAS_ENV = process.env.ASAAS_ENV || 'sandbox';
const SEU_WHATSAPP = process.env.SEU_WHATSAPP || '';
const VALOR_COTA = Number(process.env.VALOR_COTA || 1.20);

const BASE_URL =
    ASAAS_ENV === 'production'
        ? 'https://api.asaas.com/v3'
        : 'https://api-sandbox.asaas.com/v3';

const vendas = new Map();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

function gerarNumeros(qtd) {
    const usados = new Set();

    for (const venda of vendas.values()) {
        for (const numero of venda.numeros || []) {
            if (venda.status !== 'CANCELLED') {
                usados.add(numero);
            }
        }
    }

    const numeros = new Set();

    while (numeros.size < qtd) {
        const numero = String(
            Math.floor(Math.random() * 900000) + 100000
        );

        if (!usados.has(numero)) {
            numeros.add(numero);
        }
    }

    return [...numeros].sort();
}

async function asaas(path, options = {}) {
    const resposta = await fetch(BASE_URL + path, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'access_token': ASAAS_API_KEY,
            ...(options.headers || {})
        }
    });

    const texto = await resposta.text();

    let dados;

    try {
        dados = JSON.parse(texto);
    } catch (erro) {
        throw new Error(
            `Asaas retornou uma resposta inválida (HTTP ${resposta.status}).`
        );
    }

    if (!resposta.ok) {
        throw new Error(
            dados?.errors?.[0]?.description ||
            dados?.message ||
            `Erro Asaas HTTP ${resposta.status}`
        );
    }

    return dados;
}

async function enviarWhatsApp(numero, mensagem) {
    if (!FONNTE_TOKEN || !numero) {
        return;
    }

    try {
        await fetch('https://api.fonnte.com/send', {
            method: 'POST',
            headers: {
                Authorization: FONNTE_TOKEN,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                target: String(numero).replace(/\D/g, ''),
                message: mensagem
            })
        });
    } catch (erro) {
        console.error('Erro Fonnte:', erro.message);
    }
}

function msgCliente(venda) {
    return `🎉 PAGAMENTO CONFIRMADO — RIFA DO GÊMEOS!

Olá ${venda.nome}!

Seu pagamento de R$ ${Number(venda.valorTotal)
        .toFixed(2)
        .replace('.', ',')} foi confirmado.

🎟️ Seus números:

${venda.numeros.join('\n')}

🍀 Boa sorte!`;
}

function msgAdmin(venda) {
    return `🔔 NOVA VENDA CONFIRMADA!

Cliente: ${venda.nome}
WhatsApp: ${venda.whatsapp}
CPF: ${venda.cpf}
Cotas: ${venda.quantidade}
Valor: R$ ${Number(venda.valorTotal)
        .toFixed(2)
        .replace('.', ',')}

Números:
${venda.numeros.join(' | ')}`;
}

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        ambiente: ASAAS_ENV,
        asaasConfigurado: Boolean(ASAAS_API_KEY)
    });
});

app.post('/api/criar-pagamento', async (req, res) => {
    try {
        const {
            nome,
            cpf,
            whatsapp,
            quantidade
        } = req.body;

        const qtd = Number(quantidade);

        const cpfLimpo = String(cpf || '').replace(/\D/g, '');
        const whatsappLimpo = String(whatsapp || '').replace(/\D/g, '');

        if (!ASAAS_API_KEY) {
            return res.status(500).json({
                error: 'ASAAS_API_KEY não configurada no Vercel.'
            });
        }

        if (
            !nome ||
            !cpfLimpo ||
            !whatsappLimpo ||
            !Number.isInteger(qtd) ||
            qtd < 1 ||
            qtd > 100
        ) {
            return res.status(400).json({
                error: 'Dados da compra inválidos.'
            });
        }

        const valorTotal = Number(
            (qtd * VALOR_COTA).toFixed(2)
        );

        const numeros = gerarNumeros(qtd);

        const cliente = await asaas('/customers', {
            method: 'POST',
            body: JSON.stringify({
                name: nome,
                cpfCnpj: cpfLimpo,
                mobilePhone: whatsappLimpo
            })
        });

        const pagamento = await asaas('/payments', {
            method: 'POST',
            body: JSON.stringify({
                customer: cliente.id,
                billingType: 'PIX',
                value: valorTotal,
                dueDate: new Date(
                    Date.now() + 86400000
                )
                    .toISOString()
                    .split('T')[0],
                description:
                    `Rifa do Gêmeos — ${qtd} cota(s)`
            })
        });

        const pix = await asaas(
            `/payments/${pagamento.id}/pixQrCode`,
            {
                method: 'GET'
            }
        );

        vendas.set(pagamento.id, {
            id: pagamento.id,
            nome,
            cpf: cpfLimpo,
            whatsapp: whatsappLimpo,
            quantidade: qtd,
            valorTotal,
            numeros,
            status: 'PENDING',
            createdAt: new Date().toISOString()
        });

        res.json({
            paymentId: pagamento.id,
            qrCodeImage: pix.encodedImage
                ? `data:image/png;base64,${pix.encodedImage}`
                : '',
            qrCodePayload: pix.payload || '',
            numeros
        });

    } catch (erro) {
        console.error(erro);

        res.status(500).json({
            error:
                erro.message ||
                'Erro ao criar pagamento.'
        });
    }
});

app.post('/api/webhook-asaas', async (req, res) => {
    try {
        const {
            event,
            payment
        } = req.body || {};

        const venda = payment?.id
            ? vendas.get(payment.id)
            : null;

        if (
            venda &&
            (
                event === 'PAYMENT_CONFIRMED' ||
                event === 'PAYMENT_RECEIVED'
            ) &&
            venda.status !== 'CONFIRMED' &&
            venda.status !== 'RECEIVED'
        ) {
            venda.status =
                payment.status || 'RECEIVED';

            await enviarWhatsApp(
                venda.whatsapp,
                msgCliente(venda)
            );

            await enviarWhatsApp(
                SEU_WHATSAPP,
                msgAdmin(venda)
            );
        }

    } catch (erro) {
        console.error(
            'Erro no webhook:',
            erro.message
        );
    }

    res.sendStatus(200);
});

app.get('/api/status/:id', async (req, res) => {
    const venda = vendas.get(req.params.id);

    if (!venda) {
        return res.status(404).json({
            error: 'Venda não encontrada.'
        });
    }

    try {
        const pagamento = await asaas(
            `/payments/${req.params.id}`,
            {
                method: 'GET'
            }
        );

        venda.status =
            pagamento.status || venda.status;

    } catch (erro) {
        console.error(
            'Erro ao consultar pagamento:',
            erro.message
        );
    }

    res.json({
        status: venda.status,
        numeros: venda.numeros
    });
});

app.get('/api/vendas', (req, res) => {
    res.json([...vendas.values()]);
});

app.use((req, res) => {
    res.status(404).json({
        error: 'Rota não encontrada.'
    });
});

module.exports = app;

if (require.main === module) {
    const PORTA = process.env.PORT || 3000;

    app.listen(PORTA, () => {
        console.log(
            `Servidor rodando na porta ${PORTA}`
        );
    });
}
