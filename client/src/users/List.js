'use strict';

import React, { Component } from 'react';
import { translate } from 'react-i18next';
import { Title, Toolbar, NavButton } from '../lib/page';
import { Table, TableSelectMode } from '../lib/table';

@translate()
export default class List extends Component {
    render() {
        const t = this.props.t;

        const actionLinks = [
            {
                label: 'Edit',
                link: data => '/users/edit/' + data[0]
            }
        ];

        const columns = [
            { data: 0, title: "#" },
            { data: 1, title: "Username" },
            { data: 2, title: "Full Name" }
        ];

        return (
            <div>
                <Toolbar>
                    <NavButton linkTo="/users/create" className="btn-primary" icon="plus" label={t('Create User')}/>
                </Toolbar>

                <Title>{t('Users')}</Title>

                <Table withHeader dataUrl="/users/rest/usersTable" columns={columns} actionLinks={actionLinks} />
            </div>
        );
    }
}