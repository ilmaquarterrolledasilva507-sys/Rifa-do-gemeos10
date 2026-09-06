
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();

const PORT = process.env.PORT || 3000;

const ASAAS_API_KEY = process.env.ASAAS_API_KEY || '';
const FONNTE_TOKEN = process.env.FONNTE_TOKEN || '';
const ASAAS_ENV = process.env.ASAAS_ENV || 'sandbox';

const SEU_WHATSAPP = process.env.SEU_WHATSAPP || '';
const VALOR_COTA = Number(process.env.VALOR_COTA || 1.20);

const BASE_URL =
    ASAAS_ENV === 'production'
        ? 'https://api.asaas.com/v3'
        : 'https://api-sandbox.asaas.com/v3';


/* =========================
   CONFIGURAÇÃO DO EXPRESS
========================= */

app.use(cors());

app.use(
    express.json({
        limit: '1mb'
    })
);

app.use(express.static(__dirname));


/* =========================
   BANCO TEMPORÁRIO
========================= */

const vendas = new Map();


/* =========================
   GERAR NÚMEROS
========================= */

function gerarNumeros(qtd) {

    const usados = new Set();

    for (const venda of vendas.values()) {

        if (
            venda.status !== 'CANCELLED' &&
            Array.isArray(venda.numeros)
        ) {

            venda.numeros.forEach(numero => {
                usados.add(numero);
            });

        }

    }

    const numeros = new Set();

    while (numeros.size < qtd) {

        const numero =
            String(
                Math.floor(Math.random() * 900000) + 100000
            );

        if (!usados.has(numero)) {
            numeros.add(numero);
        }

    }

    return [...numeros].sort();
}


/* =========================
   COMUNICAÇÃO COM ASAAS
========================= */

async function asaas(path, options = {}) {

    if (!ASAAS_API_KEY) {

        throw new Error(
            'ASAAS_API_KEY não configurada.'
        );

    }

    const resposta = await fetch(
        BASE_URL + path,
        {
            ...options,

            headers: {
                'Content-Type': 'application/json',

                'access_token': ASAAS_API_KEY,

                ...(options.headers || {})
            }
        }
    );


    const texto =
        await resposta.text();


    let dados;

    try {

        dados =
            JSON.parse(texto);

    } catch (erro) {

        throw new Error(
            `Asaas retornou uma resposta inválida. HTTP ${resposta.status}`
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


/* =========================
   WHATSAPP
========================= */

async function enviarWhatsApp(
    numero,
    mensagem
) {

    if (!FONNTE_TOKEN || !numero) {
        return;
    }


    try {

        await fetch(
            'https://api.fonnte.com/send',
            {
                method: 'POST',

                headers: {
                    Authorization: FONNTE_TOKEN,
                    'Content-Type': 'application/json'
                },

                body: JSON.stringify({

                    target:
                        String(numero)
                        .replace(/\D/g, ''),

                    message: mensagem

                })
            }
        );

    } catch (erro) {

        console.error(
            'Erro Fonnte:',
            erro.message
        );

    }

}


/* =========================
   MENSAGEM DO CLIENTE
========================= */

function mensagemCliente(venda) {

    return `
🎉 PAGAMENTO CONFIRMADO!

RIFA DO GÊMEOS

Olá ${venda.nome}!

Seu pagamento de R$ ${Number(
        venda.valorTotal
    ).toFixed(2).replace('.', ',')} foi confirmado.

🎟️ SEUS NÚMEROS:

${venda.numeros.join('\n')}

🍀 Boa sorte!
`;

}


/* =========================
   MENSAGEM DO ADMIN
========================= */

function mensagemAdmin(venda) {

    return `
🔔 NOVA VENDA CONFIRMADA!

RIFA DO GÊMEOS

Cliente:
${venda.nome}

WhatsApp:
${venda.whatsapp}

CPF:
${venda.cpf}

Cotas:
${venda.quantidade}

Valor:
R$ ${Number(
        venda.valorTotal
    ).toFixed(2).replace('.', ',')}

Números:

${venda.numeros.join(' | ')}
`;

}


/* =========================
   TESTE DO SERVIDOR
========================= */

app.get(
    '/api/health',
    (req, res) => {

        res.json({

            ok: true,

            ambiente:
                ASAAS_ENV,

            asaasConfigurado:
                Boolean(ASAAS_API_KEY)

        });

    }
);


/* =========================
   CRIAR PAGAMENTO PIX
========================= */

app.post(
    '/api/criar-pagamento',
    async (req, res) => {

        try {

            const {
                nome,
                cpf,
                whatsapp,
                quantidade
            } = req.body;


            const qtd =
                Number(quantidade);


            const cpfLimpo =
                String(cpf || '')
                .replace(/\D/g, '');


            const whatsappLimpo =
                String(whatsapp || '')
                .replace(/\D/g, '');


            if (!ASAAS_API_KEY) {

                return res.status(500).json({

                    error:
                        'ASAAS_API_KEY não configurada na Vercel.'

                });

            }


            if (!nome) {

                return res.status(400).json({

                    error:
                        'Digite o nome do cliente.'

                });

            }


            if (
                cpfLimpo.length !== 11
            ) {

                return res.status(400).json({

                    error:
                        'CPF inválido.'

                });

            }


            if (
                whatsappLimpo.length < 10
            ) {

                return res.status(400).json({

                    error:
                        'WhatsApp inválido.'

                });

            }


            if (
                !Number.isInteger(qtd) ||
                qtd < 1 ||
                qtd > 100
            ) {

                return res.status(400).json({

                    error:
                        'Quantidade de cotas inválida.'

                });

            }


            const valorTotal =
                Number(
                    (
                        qtd *
                        VALOR_COTA
                    ).toFixed(2)
                );


            /* =========================
               CRIAR CLIENTE ASAAS
            ========================= */

            const cliente =
                await asaas(
                    '/customers',
                    {
                        method: 'POST',

                        body:
                            JSON.stringify({

                                name:
                                    nome,

                                cpfCnpj:
                                    cpfLimpo,

                                mobilePhone:
                                    whatsappLimpo

                            })
                    }
                );


            /* =========================
               CRIAR PAGAMENTO PIX
            ========================= */

            const pagamento =
                await asaas(
                    '/payments',
                    {
                        method: 'POST',

                        body:
                            JSON.stringify({

                                customer:
                                    cliente.id,

                                billingType:
                                    'PIX',

                                value:
                                    valorTotal,

                                dueDate:
                                    new Date(
                                        Date.now() +
                                        86400000
                                    )
                                    .toISOString()
                                    .split('T')[0],

                                description:
                                    `Rifa do Gêmeos - ${qtd} cota(s)`

                            })
                    }
                );


            /* =========================
               PEGAR QR CODE PIX
            ========================= */

            const pix =
                await asaas(
                    `/payments/${pagamento.id}/pixQrCode`,
                    {
                        method: 'GET'
                    }
                );


            /* =========================
               GERAR NÚMEROS OFICIAIS
            ========================= */

            const numeros =
                gerarNumeros(qtd);


            /* =========================
               SALVAR VENDA
            ========================= */

            const venda = {

                id:
                    pagamento.id,

                nome:
                    nome,

                cpf:
                    cpfLimpo,

                whatsapp:
                    whatsappLimpo,

                quantidade:
                    qtd,

                valorTotal:
                    valorTotal,

                numeros:
                    numeros,

                status:
                    'PENDING',

                createdAt:
                    new Date().toISOString()

            };


            vendas.set(
                pagamento.id,
                venda
            );


            /* =========================
               RESPONDER AO SITE
            ========================= */

            return res.json({

                paymentId:
                    pagamento.id,

                qrCodeImage:
                    pix.encodedImage
                        ? `data:image/png;base64,${pix.encodedImage}`
                        : '',

                qrCodePayload:
                    pix.payload || '',

                numeros:
                    numeros

            });


        } catch (erro) {

            console.error(
                'ERRO AO CRIAR PAGAMENTO:',
                erro
            );


            return res.status(500).json({

                error:
                    erro.message ||
                    'Erro ao criar pagamento Pix.'

            });

        }

    }
);


/* =========================
   WEBHOOK ASAAS
========================= */

app.post(
    '/api/webhook-asaas',
    async (req, res) => {

        try {

            const {
                event,
                payment
            } = req.body || {};


            if (
                !payment ||
                !payment.id
            ) {

                return res.sendStatus(200);

            }


            const venda =
                vendas.get(
                    payment.id
                );


            if (!venda) {

                return res.sendStatus(200);

            }


            if (
                event === 'PAYMENT_CONFIRMED' ||
                event === 'PAYMENT_RECEIVED'
            ) {

                if (
                    venda.status !== 'CONFIRMED' &&
                    venda.status !== 'RECEIVED'
                ) {

                    venda.status =
                        payment.status ||
                        'RECEIVED';


                    await enviarWhatsApp(
                        venda.whatsapp,
                        mensagemCliente(venda)
                    );


                    await enviarWhatsApp(
                        SEU_WHATSAPP,
                        mensagemAdmin(venda)
                    );

                }

            }


        } catch (erro) {

            console.error(
                'Erro no webhook:',
                erro.message
            );

        }


        return res.sendStatus(200);

    }
);


/* =========================
   CONSULTAR PAGAMENTO
========================= */

app.get(
    '/api/status/:id',
    async (req, res) => {

        const id =
            req.params.id;


        const venda =
            vendas.get(id);


        if (!venda) {

            return res.status(404).json({

                error:
                    'Venda não encontrada.'

            });

        }


        try {

            const pagamento =
                await asaas(
                    `/payments/${id}`,
                    {
                        method: 'GET'
                    }
                );


            if (
                pagamento.status
            ) {

                venda.status =
                    pagamento.status;

            }


        } catch (erro) {

            console.error(
                'Erro ao consultar pagamento:',
                erro.message
            );

        }


        return res.json({

            status:
                venda.status,

            numeros:
                venda.numeros

        });

    }
);


/* =========================
   LISTAR VENDAS
========================= */

app.get(
    '/api/vendas',
    (req, res) => {

        return res.json(
            [...vendas.values()]
        );

    }
);


/* =========================
   ROTA NÃO ENCONTRADA
========================= */

app.use(
    (req, res) => {

        res.status(404).json({

            error:
                'Rota não encontrada.'

        });

    }
);


/* =========================
   EXPORTAÇÃO PARA VERCEL
========================= */

module.exports = app;


/* =========================
   RODAR LOCALMENTE
========================= */

if (require.main === module) {

    app.listen(
        PORT,
        () => {

            console.log(
                `Servidor rodando na porta ${PORT}`
            );

        }
    );

}
